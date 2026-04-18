# JVS 読み上げ (test_yomiage)

iPhone (Safari) からの使用を想定した、テキストファイル読み上げアプリです。
音声は [JVS (Japanese Versatile Speech) corpus](https://sites.google.com/site/shinnosuketakamichi/research-topics/jvs_corpus)
で学習された [ESPnet-TTS](https://github.com/espnet/espnet) の事前学習済み多話者
日本語 VITS モデルを用いて合成します (例: `kan-bayashi/jvs_jvs010_vits_prosody`)。

## 機能

- 保存されているテキストファイル (`texts/*.txt`) を一覧から選んで読み上げ
- 読み上げ速度 0.5x〜2.0x を 0.1x 刻みで可変
- シークバーで再生位置を自由に選択
- 10秒 / 60秒 の巻き戻し・早送りボタン
- iPhone で指でタップしやすい大きなボタン、セーフエリア対応、ダークテーマ

## 構成

```
backend/     FastAPI + ESPnet-TTS サーバー
frontend/    iPhone Safari 向け Web UI (HTML / CSS / JS)
texts/       読み上げ対象のテキスト (.txt) を置くディレクトリ
```

## セットアップ

Python 3.10+ 推奨 (ESPnet の要件)。

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

初回起動時に JVS 学習済みモデルが自動ダウンロードされます
(`.cache/espnet/` にキャッシュ)。回線状況によっては数百 MB 程度かかります。

別のモデルを使いたい場合は環境変数で切り替えられます。

```bash
export JVS_MODEL_TAG="kan-bayashi/jvs_jvs010_vits_prosody"
```

## 起動

```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
```

iPhone から同一 LAN のサーバーにアクセスします。

```
http://<PC の IP>:8000/
```

Safari で開き、「ホーム画面に追加」すると PWA 風に使えます。

## 使い方

1. 読み上げたいテキストを `texts/sample.txt` のように `.txt` で配置
2. アプリで一覧から選択 → 必要に応じて編集
3. 「このテキストを読み込む」で音声を合成 (サーバー側でキャッシュ)
4. ▶ で再生。速度スライダー、シークバー、±10秒 / ±60秒 ボタンで操作

## API

| Method | Path                   | 説明                               |
| ------ | ---------------------- | ---------------------------------- |
| GET    | `/api/texts`           | `texts/` の `.txt` 一覧            |
| GET    | `/api/texts/{name}`    | テキスト本文の取得                 |
| POST   | `/api/synthesize`      | `{ "text": "..." }` から WAV を返す |

## 高速化オプション

長文読み上げ時の待ち時間を減らすための設定。

### 1. GPU を使う (NVIDIA CUDA)

NVIDIA GPU があれば JVS の合成が 5〜20 倍速くなります。WSL2 でも
Windows 側に最新の NVIDIA ドライバが入っていれば CUDA が使えます。

**Windows 側:**

1. [NVIDIA 公式](https://www.nvidia.com/Download/index.aspx) から最新
   Game Ready / Studio ドライバをインストール (WSL 対応は 470 以降)
2. PowerShell で `nvidia-smi` が動くか確認

**WSL 側 (Ubuntu):**

```bash
nvidia-smi   # Windows と同じ情報が見えれば OK
# venv 内で
python -c "import torch; print(torch.cuda.is_available())"
```

`True` が返れば自動で GPU が使われます。明示したい場合:

```bash
JVS_DEVICE=cuda uvicorn main:app --host 0.0.0.0 --port 8000
# 強制 CPU
JVS_DEVICE=cpu uvicorn main:app --host 0.0.0.0 --port 8000
```

`/api/engines` の `device` フィールドで現在のデバイスが確認できます。
UI のエンジン名にも `[cuda]` / `[cpu]` と表示されます。

### 2. VITS の monotonic_align を Cython でビルド

起動時ログの警告

```
Cython version is not available. Fallback to 'EXPERIMETAL' numba version.
```

を解消すると合成が 1〜2 割速くなります。

```bash
cd ~/test_yomiage/backend
source .venv/bin/activate
cd .venv/lib/python3.11/site-packages/espnet2/gan_tts/vits/monotonic_align
python setup.py build_ext --inplace
```

完了後に uvicorn を再起動すれば警告が消えます。

### 3. VOICEVOX を併用 (軽量・高速)

[VOICEVOX](https://voicevox.hiroshiba.jp/) は CPU でもリアルタイム以上で
動く日本語 TTS です。UI の「エンジン」プルダウンで切り替えられます。
JVS モデルは使わないので話者は VOICEVOX のものになります。

**Docker で起動 (推奨)**

```bash
# CPU 版
docker run -d --rm -p '127.0.0.1:50021:50021' \
  --name voicevox voicevox/voicevox_engine:cpu-latest
# GPU 版 (NVIDIA)
docker run -d --rm --gpus all -p '127.0.0.1:50021:50021' \
  --name voicevox voicevox/voicevox_engine:nvidia-latest
```

**起動後の確認**

```bash
curl http://127.0.0.1:50021/version
```

アプリを再読み込みするとエンジン選択に「VOICEVOX」が追加されます。
話者プルダウンで好きなキャラクター/スタイルを選んで合成できます。

**環境変数**

```bash
# 別ホストで起動している場合
VOICEVOX_URL=http://192.168.1.50:50021 uvicorn main:app ...
```

## 注意

- JVS コーパスおよびそれを用いた学習済みモデルは、各配布元のライセンス
  (研究目的など) に従って利用してください。商用利用や再配布の可否は各自で
  ご確認ください。
- VOICEVOX の音声を公開・商用利用する場合は各キャラクターの利用規約に
  従ってください ([公式](https://voicevox.hiroshiba.jp/term/))。
- 合成には GPU があると高速ですが、CPU でも動作します (初回は遅め)。
