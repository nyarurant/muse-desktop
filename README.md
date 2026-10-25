# Muse Desktop Community

[Muse](https://muse.ai/) と会話するための、**非公式**の Windows デスクトップアプリです（Windows 10 / 11）。

> **注意:** このプロジェクトは Meta Platforms, Inc. とは関係がなく、Meta による承認・保証・サポートを受けていません。「Muse」「Meta」は各社の商標です。
> 公開 API ではなく、muse.ai の Web 版が内部で使っている通信や仕組みを読み解いて使っています。Meta 側の変更でいつでも動かなくなる可能性があり、利用規約上の扱いも保証できません。**自己責任で**使ってください。
> PC 連携を有効にすると、Muse（Meta のサーバー上の AI）がこの PC のコマンドやファイルを扱えるようになります。内容を理解したうえで使ってください。

会話画面はアプリ内の HTML/CSS/JavaScript で描画し、muse.ai の Web 版と同じゲートウェイ API を使って、Muse の VM と Noise XX で暗号化した通信を直接行います。

## インストール

配布用のビルドはまだないので、ソースからビルドします（Node.js が必要です）。

```powershell
npm.cmd install
npm.cmd run dist:win       # インストーラー: dist/Muse Desktop Community Setup <version>.exe
npm.cmd run dist:portable  # ポータブル版: dist/Muse Desktop Community <version>.exe
```

できた exe を動かすだけなら Node.js は要りません。コード署名はしていないので、初回は Windows SmartScreen の警告が出ます（「詳細情報」→「実行」）。

## 使い方

ログインは必須です。ログインしていないと、アプリの画面全体がログイン画面になり、その中に表示される Meta のページで Muse アカウントにログインします（入力した内容はアプリには渡りません）。完了すると自動で接続し、いつもの画面に戻ります。
接続のたびに新しいトークンを取り直すので、ログインしたままなら接続が切れても自動で戻ります。ログインが切れたときは、またログイン画面になります。
接続情報は Windows の暗号化ストレージで暗号化し、`%APPDATA%/Muse App/muse-session.enc` に保存します。設定なども `%APPDATA%/Muse App` に保存します。

## 機能

- メインチャットとサイドチャットでの会話（Markdown 表示、ストリーミング表示、停止）
- サイドチャットのピン留め・名前変更・アーカイブ・削除、アーカイブ済みの表示
- 全チャットのメッセージ検索と、該当メッセージへのジャンプ
- 返信、リアクション、メッセージの削除、回答の出典リンク表示
- 画像・ファイルの添付（＋ボタン、貼り付け、ドラッグ＆ドロップ。1 つ 10 MB まで）
- 音声入力（入力欄のマイク。Web 版と同じ Meta の音声認識。トークンと通信はメインプロセスだけで扱う）
- 会話の時刻の区切り、スクロールすると上に出るアバターと名前（Web 版と同じ）
- フィード・アイデア・目標・ライブラリ。ライブラリは Web 版と同じくサイドバーに分類（すべて／ドキュメント／ウェブアーティファクト／画像／動画）、カードに中身のプレビュー。クリックで保存
- 右パネル：アクティビティ（押すとステップと結果の詳細）、承認、近日開催予定。アバターは Web 版と同じ動画（待機中／作業中で切り替え）
- 設定（`Ctrl+,`）：Web 版と同じ構成。利用状況（プラン・使用率）、テーマカラー、アクセス許可のデフォルト、デバイス、コネクター、メッセージチャネル、AI モデルの改善への協力は Web 版と同じデータを読み書き。支払い方法・パスワード・データの削除やリセットは Web 版で変更
- このアプリでの自動許可（手動 / 安全なものだけ / 重要なものだけ確認 / Bypass）。設定のアクセス許可にあります
- 作業が途中で止まったときの自動再開（`[System]` 付きの指示を送る。自分で停止したときは送らない）
- ローカル作業ページ（PC 接続のオン／オフ、作業フォルダー、コマンド実行、実行ログ。メインウィンドウ内、左のバーの端末アイコンまたは `Ctrl+Shift+T`）
- 「PC 接続の設定」で SDK トークンの準備、メール／電話番号の認証、必要なアカウント選択や追加認証をアプリ内で完了。発行済みのトークンは再利用
- 認証済みの PC は Muse の端末として起動時に自動で接続（切れたら自動で再接続。ローカル作業ページでオフにするとその間は止まります）。接続中はどの会話からでも、Muse がこの PC のコマンド（`system.run`）・ファイルの読み書き・状態確認を使えます。要求と結果は端末用の通信経路で送受信し、チャット本文のツール指示は解析しません
- ローカル作業ページの「PC タスク」から、新しいサイドチャットで PC 作業を開始することも可能

`Enter` で送信、`Shift+Enter` で改行します。
`Ctrl+N` で新しいサイドチャット、`Ctrl+K` で検索、`Alt+Shift+Space` でウィンドウの表示・非表示を切り替えます。
ウィンドウを閉じてもトレイに残り、Muse の承認の自動化や自動再開はそのまま動きます。

## 安全のために

PC 端末の認証情報は `%APPDATA%/Muse App/muse-device.enc` に暗号化して保存します。認証コードは保存せず、認証情報や SDK トークンの値は会話画面へ渡しません。認証済みの PC は起動時に自動で接続し、Web 版の「設定 › デバイス」にも表示されます。

端末通信は [Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux) の `link.register` / `link.invoke` / `link.result` に対応します。PC 単体での認証スキーマは [Muse Desktop Bridge のプロトコル資料](https://github.com/chaitanyarahalkar/muse-desktop-bridge/blob/main/docs/protocol.md) を参照しています。利用状況や音声入力も Web 版の内部の仕組みを使っています。どれも非公式の連携で、Meta 側の変更で動かなくなったり、再認証が必要になったりすることがあります。

Muse の VM の暗号キーは VM が再起動するたびに変わります。Web 版と同じく新しいキーを受け入れて接続し、そのたびに画面で知らせて、変わった日時を `%APPDATA%/Muse App/gateway-pins.json` に記録します。
接続が切れたときは、アプリが自動で再接続します（3 秒から最長 1 分間隔。ログインが必要なときは止まって知らせます）。
承認の自動化を Bypass にすると、支払い・購入やメディアの送信も確認なしで許可されます。
Muse がこの PC で行う操作のうち、フォルダーの一括削除、ディスク・レジストリ・サービス・ブート設定の変更、シャットダウン、ユーザーや権限の変更、タスクスケジューラへの登録、バックアップの削除、ネットから取得したものの即実行、中身の見えない PowerShell、Git の強制 push・reset --hard・clean、システムフォルダーやスタートアップへの書き込みは、実行前に確認します（答えないと実行しません。設定 › アクセス許可でオフにできます）。それ以外の操作は確認なしで動き、フォルダーの外にも読み書きできます。よくある危険なパターンを止めるだけで、サンドボックスではありません。
Muse が読んだファイルの中身やコマンドの結果は Muse（Meta のサーバー）に送られます。通信や作業が中断した場合、ローカル操作の自動再実行は行いません。

## 開発

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
npm.cmd start
npm.cmd run dist:portable
npm.cmd run dist:win
```

実際のアカウントで接続を確認する（読み取りのみ）:

```powershell
npm.cmd run test:live -- --har="C:/path/to/capture.devtools"
```

`--send-test` を付けると、メインチャットとは別のサイドチャットを作り、無害な確認メッセージを 1 通だけ送って返信を確かめます。

アプリを `--remote-debugging-port=9337` 付きで起動しておくと、`npm.cmd run test:ui` で画面の動作（履歴、送信と返信、下書き、設定の全セクションと利用状況、ライブラリ、ローカル作業、アクティビティ、狭い画面）を確認できます。
この確認では新しいサイドチャットから実際に 1 通メッセージを送り、終わったらそのサイドチャットをアーカイブします。

ファイル構成（`src/`）:

- `main.js`: Electron のメインプロセス、`desktop-api.js`: 画面との IPC と Muse への各種リクエスト
- `muse-client.js`: ゲートウェイ API クライアント、`noise.js`: 暗号化通信、`chat-model.js`: 会話データの整形
- `app.html` / `app.css` / `app-renderer.js`: 会話画面。`settings-renderer.js`（設定）、`workspace-renderer.js`（ローカル作業）、`activity-renderer.js`（アクティビティ詳細）、`dictation-renderer.js`（音声入力）、`pc-setup-renderer.js`（PC 接続の設定）
- `pc-auth.js` / `pc-auth-store.js`: PC の認証、`native-device.js`: 端末通信、`native-executor.js`: PC での実行、`pc-safety.js`: 危険な操作の判定
- `muse-approval-policy.js`: 自動許可の判定、`auto-resume.js`: 自動再開の判定、`login-flow.js`: ログイン検出

## ライセンス

MIT License（[LICENSE](LICENSE)）。
