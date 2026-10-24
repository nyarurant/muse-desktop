# Muse App 0.4.0

Muse と会話するための、非公式の Windows デスクトップアプリです。
会話画面はアプリ内の HTML/CSS/JavaScript で描画し、muse.ai の Web 版と同じゲートウェイ API を使って、Muse の VM と Noise XX で暗号化した通信を直接行います。

## 使い方

`dist/Muse App 0.4.0.exe` を起動します。Node.js のインストールは不要です。
初回は「接続と設定」から Muse アカウントでログインするか、ブラウザの DevTools で保存した通信記録（`.devtools` / `.har`）を読み込みます。
接続情報は Windows の暗号化ストレージで暗号化し、`%APPDATA%/Muse App/muse-session.enc` に保存します。通信記録そのものはコピーしません。
Meta の公式アプリではありません（Muse Desktop Community のコミュニティ版です）。

## 機能

- メインチャットとサイドチャットでの会話（Markdown 表示、ストリーミング表示、停止）
- サイドチャットのピン留め・名前変更・アーカイブ・削除、アーカイブ済みの表示
- 全チャットのメッセージ検索と、該当メッセージへのジャンプ
- 返信、リアクション、メッセージの削除、回答の出典リンク表示
- 画像・ファイルの添付（＋ボタン、貼り付け、ドラッグ＆ドロップ。1 つ 10 MB まで）
- フィード・アイデア・目標・ライブラリ（Muse が作ったファイルや画像の保存）
- 右パネル：アクティビティ、承認、近日開催予定
- Muse の承認の自動化（手動 / 自動 / 重要なものだけ確認 / Bypass）
- 作業が途中で止まったときの自動再開（`[System]` 付きの指示を送る。自分で停止したときは送らない）
- ローカルでコマンドを実行する別ウィンドウ（`Ctrl+Shift+T`）

`Enter` で送信、`Shift+Enter` で改行します。
`Ctrl+N` で新しいサイドチャット、`Ctrl+K` で検索、`Alt+Shift+Space` でウィンドウの表示・非表示を切り替えます。
ウィンドウを閉じてもトレイに残り、Muse の承認の自動化や自動再開はそのまま動きます。

## 安全のために

Muse の VM の暗号キーは初回接続時に記録し（`%APPDATA%/Muse App/gateway-pins.json`）、次回以降に変わっていたら接続を止めます。VM の再起動などで正当に変わった場合は、このファイルの該当エントリを消すと新しいキーで接続し直します。
承認の自動化を Bypass にすると、支払い・購入やメディアの送信も確認なしで許可されます。
ローカルのコマンド実行ウィンドウは、選んだ作業フォルダーの外にもアクセスできます。サンドボックスではありません。

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

アプリを `--remote-debugging-port=9337` 付きで起動しておくと、`npm.cmd run test:ui` で画面の動作（接続、履歴、送信、設定、検索、狭い画面）を確認できます。
この確認では実際に 1 通メッセージを送ります。

ファイル構成: `main.js` が Electron のメインプロセス、`desktop-api.js` が画面との IPC、`muse-client.js` が API クライアント、`noise.js` が暗号化通信、`app.html` / `app.css` / `app-renderer.js` が会話画面です。
承認の自動判定は `muse-approval-policy.js`、自動再開の判定は `auto-resume.js` にあります。

Meta とは関係のないコミュニティ製のプロトタイプです。
