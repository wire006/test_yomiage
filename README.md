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

## 注意

- JVS コーパスおよびそれを用いた学習済みモデルは、各配布元のライセンス
  (研究目的など) に従って利用してください。商用利用や再配布の可否は各自で
  ご確認ください。
- 合成には GPU があると高速ですが、CPU でも動作します (初回は遅め)。
