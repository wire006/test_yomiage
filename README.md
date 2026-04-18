# 読み上げアプリ (test_yomiage)

iPhone (Safari) からの使用を想定した、テキストファイル読み上げアプリです。
音声合成には [VOICEVOX](https://voicevox.hiroshiba.jp/) を使用します。

## 機能

- サーバ上のテキスト (`texts/*.txt`) または端末のファイルを選んで読み上げ
- VOICEVOX 話者から自由に選択 (初期値: 冥鳴ひまり / ノーマル)
- 読み上げ速度 0.5x〜2.0x を 0.1x 刻みで可変
- シークバー、10秒 / 60秒 の巻き戻し・早送り
- ストリーミング再生 (最初のチャンクが出来次第再生開始、裏で残りを合成)
- 端末内で音量調整 (Web Audio Gain)
- エンジン/話者の選択を localStorage に保存
- Cloudflare Tunnel で外出先からもアクセス可

## 構成

```
backend/     FastAPI サーバ (VOICEVOX を HTTP 経由で呼ぶ)
frontend/    iPhone Safari 向け Web UI
texts/       読み上げ対象のテキスト (.txt) を置くディレクトリ
```

## セットアップ

Python 3.10+。

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

## VOICEVOX Engine の起動

Docker 推奨。GPU 版がある場合は `--gpus all` を付けると高速になります。

```bash
# GPU 版 (NVIDIA + nvidia-container-toolkit が必要)
docker run -d --rm --gpus all -p '0.0.0.0:50021:50021' \
  --name voicevox voicevox/voicevox_engine:nvidia-ubuntu22.04-latest

# CPU 版 (GPU が無い場合)
docker run -d --rm -p '0.0.0.0:50021:50021' \
  --name voicevox voicevox/voicevox_engine:cpu-latest

# 起動確認
curl http://127.0.0.1:50021/version
```

別ホストで起動している場合は環境変数で指定します。

```bash
VOICEVOX_URL=http://192.168.1.50:50021 uvicorn main:app ...
```

## アプリの起動

```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
```

同一 LAN の iPhone から `http://<PC の IP>:8000/` にアクセス。
Safari で「ホーム画面に追加」すると PWA 風に使えます。

## 使い方

1. 読み上げたいテキストを `texts/*.txt` に置くか、「端末から選ぶ」で iPhone 内のファイルを読む
2. 話者を選ぶ (初回は VOICEVOX / 冥鳴ひまり / ノーマル)
3. 「このテキストを読み込む」で一括合成、または「ストリーミング再生」で即再生
4. シークバーや ±10 / ±60 秒ボタンで操作

## API

| Method | Path                               | 説明                                  |
| ------ | ---------------------------------- | ------------------------------------- |
| GET    | `/api/texts`                       | `texts/` の `.txt` 一覧               |
| GET    | `/api/texts/{name}`                | テキスト本文                          |
| GET    | `/api/engines`                     | 利用可能なエンジン (VOICEVOX のみ)    |
| GET    | `/api/engines/voicevox/voices`     | VOICEVOX の話者一覧                   |
| POST   | `/api/synthesize`                  | 一括合成 WAV                          |
| POST   | `/api/stream/start`                | ストリーミングセッション開始          |
| GET    | `/api/stream/{sid}/status`         | 進捗ポーリング                        |
| GET    | `/api/stream/{sid}/chunk/{idx}`    | 合成済みチャンク WAV                  |

## 外出先からのアクセス (Cloudflare Tunnel)

自宅ルータの設定やグローバル IP 無しで、インターネット経由の iPhone から
アプリに到達できます。試用目的なら無料でドメイン登録も不要です。

### 1. cloudflared のインストール (WSL2 / Ubuntu)

```bash
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

### 2a. クイック起動 (使い捨て URL)

Cloudflare アカウント不要、起動のたびに URL が変わります。試用向け。

```bash
# 先に uvicorn を起動しておく (別ターミナル)
uvicorn main:app --host 127.0.0.1 --port 8000 --forwarded-allow-ips='*' --proxy-headers

# 別ターミナルでトンネルを張る
cloudflared tunnel --url http://127.0.0.1:8000
```

ログに出る `https://xxxxx-xxxxx.trycloudflare.com` を iPhone で開く。

### 2b. 固定 URL (Cloudflare アカウント + 自分のドメイン)

外から毎回同じ URL を使いたい場合。

```bash
# 1. ブラウザでログイン
cloudflared tunnel login

# 2. トンネル作成 (一度だけ)
cloudflared tunnel create yomiage

# 3. ~/.cloudflared/config.yml を作成
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: yomiage
credentials-file: /home/<USER>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: yomiage.example.com
    service: http://127.0.0.1:8000
  - service: http_status:404
EOF

# 4. DNS を Cloudflare に登録
cloudflared tunnel route dns yomiage yomiage.example.com

# 5. 起動
cloudflared tunnel run yomiage
```

iPhone から `https://yomiage.example.com/` で到達。

### 3. アクセス制限 (推奨)

公開 URL に誰でも到達できる状態なので、Cloudflare Zero Trust の
Access Application で自分の Google / メールアドレスだけ通す設定を
被せるのが安全です (無料プランで可)。

### 4. uvicorn 側のヒント

プロキシ越しだと `X-Forwarded-*` ヘッダが入ります。正しい URL / IP を
ログに残したい場合は起動オプションで以下を付けます。

```bash
uvicorn main:app --host 127.0.0.1 --port 8000 \
  --proxy-headers --forwarded-allow-ips='*'
```

`--host 127.0.0.1` にすると LAN には公開されず、Cloudflare Tunnel 経由
だけで届くようになります (外部公開を Cloudflare Access 限定にしたい場合
に便利)。

## 注意

- VOICEVOX の音声を公開・商用利用する場合は各キャラクターの利用規約に
  従ってください ([公式](https://voicevox.hiroshiba.jp/term/))。
- Cloudflare Tunnel の trycloudflare.com は URL が毎回変わり、帯域制限や
  将来の仕様変更があります。恒常的に使うならアカウント + DNS 登録を推奨。
