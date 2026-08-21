#!/bin/bash
#
# CALM — TestFlight ワンコマンド リリース
#
#   ./release.sh              アーカイブ〜検証〜アップロードまで全部
#   ./release.sh --dry-run    アーカイブとIPA書き出しのみ（アップロードしない）
#   ./release.sh --validate   検証まで（アップロードしない）
#
# バージョンは index.html の `var ver = 'v1.1.4.39'` から自動取得し、
#   1.1.4  → MARKETING_VERSION（App Storeのバージョン表記）
#   39     → CURRENT_PROJECT_VERSION（TestFlightのビルド番号）
# としてXcodeプロジェクトへ書き込む。アプリ内の表示とビルド番号が一致するので
# テスターのフィードバックがどのビルドのものか特定できる。
#
set -euo pipefail

SRC="/Users/manabukatoh/Library/Mobile Documents/com~apple~CloudDocs/CALM/index.html"
APP="$HOME/CALM-app"
PROJ="$APP/ios/App/App.xcodeproj"
PBX="$PROJ/project.pbxproj"
OUT="$APP/build"
ARCHIVE="$OUT/App.xcarchive"
CONF="$APP/.asc-config"

MODE="upload"
case "${1:-}" in
  --dry-run)  MODE="export" ;;
  --validate) MODE="validate" ;;
  "")         MODE="upload" ;;
  *) echo "不明なオプション: $1"; exit 2 ;;
esac

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. App Store Connect API キーの読み込み ────────────────────────────
# .asc-config には KEY_ID と ISSUER_ID だけを書く（秘密鍵 .p8 は別の場所）
if [ "$MODE" != "export" ]; then
  [ -f "$CONF" ] || die "$CONF がありません。README-release.md の手順1を実行してください。"
  # shellcheck disable=SC1090
  source "$CONF"
  : "${KEY_ID:?.asc-config に KEY_ID がありません}"
  : "${ISSUER_ID:?.asc-config に ISSUER_ID がありません}"
  KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
  [ -f "$KEY_PATH" ] || die "秘密鍵が見つかりません: $KEY_PATH"
  AUTH=(-allowProvisioningUpdates
        -authenticationKeyPath "$KEY_PATH"
        -authenticationKeyID "$KEY_ID"
        -authenticationKeyIssuerID "$ISSUER_ID")
else
  AUTH=(-allowProvisioningUpdates)
fi

# ── 2. バージョン取得 ──────────────────────────────────────────────
[ -f "$SRC" ] || die "index.html が見つかりません: $SRC"
VER=$(grep -m1 "^var ver = " "$SRC" | sed -E "s/.*'v?([0-9.]+)'.*/\1/")
[ -n "$VER" ] || die "index.html から var ver を読み取れませんでした。"
MARKETING=$(echo "$VER" | cut -d. -f1-3)
BUILD=$(echo "$VER" | cut -d. -f4)
[ -n "$BUILD" ] || die "var ver = 'v$VER' に4桁目（ビルド番号）がありません。"

PREV=$(grep -m1 'CURRENT_PROJECT_VERSION' "$PBX" | sed -E 's/[^0-9]*([0-9]+).*/\1/')
say "バージョン $MARKETING / ビルド $BUILD（前回のビルド: $PREV）"
if [ "$BUILD" -le "$PREV" ]; then
  die "ビルド番号 $BUILD は前回の $PREV 以下です。App Store Connect は同じ番号を受け付けません。
    index.html の var ver を上げてください（例: v$MARKETING.$((PREV+1))）。"
fi

# ── 3. Web資産の同期 ──────────────────────────────────────────────
say "index.html を www/ へ同期"
cp "$SRC" "$APP/www/index.html"
cd "$APP"
npx --no-install cap copy ios

# ── 4. バージョンをXcodeプロジェクトへ書き込み ──────────────────────
say "Xcodeプロジェクトのバージョンを更新"
sed -i '' -E "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = $MARKETING;/g" "$PBX"
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [^;]*;/CURRENT_PROJECT_VERSION = $BUILD;/g" "$PBX"

# ── 5. アーカイブ ────────────────────────────────────────────────
say "アーカイブ中（数分かかります）"
rm -rf "$ARCHIVE"
# ログ整形は xcbeautify があれば使う。なければ素のログをファイルへ残して要点だけ表示。
LOG="$OUT/xcodebuild.log"
mkdir -p "$OUT"
set +e
if command -v xcbeautify >/dev/null 2>&1; then
  xcodebuild \
    -project "$PROJ" -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
    "${AUTH[@]}" clean archive 2>&1 | tee "$LOG" | xcbeautify
  RC=${PIPESTATUS[0]}
else
  xcodebuild \
    -project "$PROJ" -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
    "${AUTH[@]}" clean archive > "$LOG" 2>&1
  RC=$?
  grep -E 'error:|warning: .*(signing|provision)' "$LOG" | head -20 || true
fi
set -e
[ "$RC" -eq 0 ] || die "アーカイブ失敗（終了コード $RC）。詳細: $LOG"
[ -d "$ARCHIVE" ] || die "アーカイブが作られませんでした。詳細: $LOG"

# ── 6. IPA 書き出し ──────────────────────────────────────────────
say "IPA を書き出し"
rm -rf "$OUT/export"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$APP/ios/App/ExportOptions.plist" \
  -exportPath "$OUT/export" \
  "${AUTH[@]}"

IPA=$(find "$OUT/export" -name '*.ipa' -maxdepth 1 | head -1)
[ -n "$IPA" ] || die "IPA が見つかりません。"
say "IPA: $IPA ($(du -h "$IPA" | cut -f1))"

if [ "$MODE" = "export" ]; then
  say "--dry-run のためここで終了。アップロードしていません。"
  exit 0
fi

# ── 7. 検証 ─────────────────────────────────────────────────────
say "App Store Connect で検証"
xcrun altool --validate-app -f "$IPA" -t ios \
  --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID"

if [ "$MODE" = "validate" ]; then
  say "--validate のためここで終了。アップロードしていません。"
  exit 0
fi

# ── 8. アップロード ──────────────────────────────────────────────
say "アップロード中"
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID"

printf '\n\033[1;32m✓ 完了 — %s (ビルド %s) をアップロードしました\033[0m\n' "$MARKETING" "$BUILD"
echo "  App Store Connect で処理が終わるまで5〜15分ほどかかります。"
echo "  処理が終わると TestFlight に自動で配布されます。"
