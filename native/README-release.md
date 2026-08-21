# CALM — TestFlight リリース自動化

Xcodeを開かずに、ターミナルでコマンド1つでTestFlightへ配布できます。

```bash
cd ~/CALM-app && ./release.sh
```

これだけで以下が全部走ります。

1. `index.html` の `var ver` からバージョンとビルド番号を取得
2. iCloudの `index.html` を `www/` へ同期（`cap copy ios`）
3. Xcodeプロジェクトのバージョンを書き換え
4. アーカイブ（署名込み）
5. IPA書き出し
6. App Store Connect で検証
7. アップロード

処理が終わればTestFlightに自動で現れます。

---

## 初回だけ必要な設定（15分程度）

### 手順1. App Store Connect API キーを作る

Xcodeの対話ログインの代わりにこのキーを使うので、以後パスワード入力が一切不要になります。

1. https://appstoreconnect.apple.com を開く
2. **ユーザとアクセス** → 上のタブで **統合**（Integrations）→ **App Store Connect API**
3. **チームキー**（Team Keys）タブを選ぶ
4. **＋** を押す
5. 名前: `CALM Release`、アクセス権: **App Manager**
6. **生成** を押す

すると一覧に行が追加されます。ここから3つの情報を取ります。

| 必要なもの | どこにあるか |
|---|---|
| **キーID** | 一覧の「キーID」列（10文字程度の英数字） |
| **Issuer ID** | 一覧の上のほうに表示されている長いUUID。「コピー」リンクがあります |
| **秘密鍵ファイル** | 行の右の **APIキーをダウンロード** から `AuthKey_XXXXXXXXXX.p8` を保存 |

> ⚠️ 秘密鍵 `.p8` はダウンロードが**1回だけ**です。取り直せないので必ず保存してください。
> 万一なくしたらそのキーを失効させて新しく作り直します。

### 手順2. 秘密鍵を置く

ダウンロードした `.p8` を所定の場所へ移動します。`AuthKey_` で始まるファイル名は変えないでください。

```bash
mkdir -p ~/.appstoreconnect/private_keys && mv ~/Downloads/AuthKey_*.p8 ~/.appstoreconnect/private_keys/
```

### 手順3. キーIDとIssuer IDを書く

`~/CALM-app/.asc-config` というファイルを作り、手順1で確認した2つの値を書きます。
（このファイルには秘密鍵そのものは入りません。IDだけです。gitにも入りません）

```bash
cat > ~/CALM-app/.asc-config <<'EOF'
KEY_ID=ここにキーID
ISSUER_ID=ここにIssuer ID
EOF
```

### 手順4. 動作確認

アップロードせずにアーカイブだけ試します。

```bash
cd ~/CALM-app && ./release.sh --dry-run
```

`IPA: ...` と表示されれば準備完了です。

---

## 使い方

| コマンド | 動作 |
|---|---|
| `./release.sh` | アーカイブ → 検証 → **アップロード** |
| `./release.sh --validate` | 検証まで。アップロードしない |
| `./release.sh --dry-run` | IPA書き出しまで。署名の確認用 |

### バージョンの上げ方

`index.html` の1行を書き換えるだけです。

```js
var ver = 'v1.1.4.40';
```

- `1.1.4` → App Storeの**バージョン**表記
- `40` → TestFlightの**ビルド番号**

アプリ内の表示とTestFlightのビルド番号が一致するので、テスターから
「v1.1.4.40で不具合」と報告が来たらどのビルドか即座に分かります。

App Store Connect は同じビルド番号を二度受け付けません。スクリプトは
前回のビルド番号と比べて、上がっていなければアップロード前に止まります。

---

## うまくいかないとき

**`ビルド番号 39 は前回の 39 以下です`**
`index.html` の `var ver` の4桁目を上げてください。

**`秘密鍵が見つかりません`**
`ls ~/.appstoreconnect/private_keys/` を確認。ファイル名が
`AuthKey_<キーID>.p8` の形で、`.asc-config` の `KEY_ID` と一致している必要があります。

**アーカイブが失敗する**
`~/CALM-app/build/xcodebuild.log` に全ログが残ります。`error:` を検索してください。
署名まわりのエラーなら、一度Xcodeで App ターゲットの Signing & Capabilities を
開いて `P5664CVL42` が選ばれているか確認します。

**検証で「Invalid Bundle」などが出る**
`--validate` で内容を確認します。アップロード前に止まるので安全です。

---

## 参考: 手作業でやる場合

Xcodeでやるなら Product → Archive → Distribute App → App Store Connect → Upload。
このスクリプトはそれと同じことをコマンドで実行しています。
