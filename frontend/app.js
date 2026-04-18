(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const select = $("text-select");
  const reloadBtn = $("reload-btn");
  const localFileBtn = $("local-file-btn");
  const localFileInput = $("local-file-input");
  const textContent = $("text-content");
  const loadBtn = $("load-btn");
  const streamBtn = $("stream-btn");
  const audio = $("audio");
  const seek = $("seek");
  const playBtn = $("play-btn");
  const currentTimeEl = $("current-time");
  const durationEl = $("duration");
  const speedRange = $("speed-range");
  const speedLabel = $("speed-label");
  const volumeRange = $("volume-range");
  const volumeLabel = $("volume-label");
  const muteBtn = $("mute-btn");
  const engineSelect = $("engine-select");
  const voiceRow = $("voice-row");
  const voiceSelect = $("voice-select");
  const statusEl = $("status");

  let engines = [];
  let seeking = false;
  let muted = false;
  let audioCtx = null;
  let gainNode = null;

  const PREFS_KEY = "yomiage.prefs.v1";
  const DEFAULT_PREFS = {
    engine: "voicevox",
    voiceName: "冥鳴ひまり / ノーマル",
    voiceId: null,
  };

  const normalizeName = (s) => (s || "").replace(/\s+/g, "").toLowerCase();

  const loadPrefs = () => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return { ...DEFAULT_PREFS };
      return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  };

  const savePrefs = (patch) => {
    try {
      const next = { ...loadPrefs(), ...patch };
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  let prefs = loadPrefs();

  // streamState: {
  //   sessionId, total, durations[], ready[], done, error,
  //   currentIdx, baseTime, loadingIdx, pollTimer, preloadedIdx
  // }
  let streamState = null;

  const formatTime = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const setStatus = (msg) => {
    statusEl.textContent = msg;
  };

  const clampSpeed = (v) => {
    const n = Math.round(Number(v) * 10) / 10;
    if (!Number.isFinite(n)) return 1.0;
    return Math.min(2.0, Math.max(0.5, n));
  };

  const applySpeed = () => {
    const rate = clampSpeed(speedRange.value);
    speedRange.value = rate.toFixed(1);
    speedLabel.textContent = `${rate.toFixed(1)}x`;
    audio.playbackRate = rate;
    audio.defaultPlaybackRate = rate;
  };

  const ensureAudioGraph = () => {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      audioCtx = new AC();
      const source = audioCtx.createMediaElementSource(audio);
      gainNode = audioCtx.createGain();
      source.connect(gainNode).connect(audioCtx.destination);
    } catch {
      audioCtx = null;
      gainNode = null;
    }
  };

  const resumeAudioCtx = async () => {
    if (audioCtx && audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch {
        // ignore
      }
    }
  };

  const applyVolume = () => {
    const raw = Number(volumeRange.value);
    const v = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
    const effective = muted ? 0 : v;
    if (gainNode) {
      gainNode.gain.value = effective;
    } else {
      audio.volume = effective;
    }
    volumeLabel.textContent = `${Math.round(v * 100)}%`;
    muteBtn.textContent = muted ? "解除" : "ミュート";
    muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
  };

  const toggleMute = () => {
    muted = !muted;
    applyVolume();
  };

  const totalKnownDuration = () => {
    if (!streamState) return 0;
    let sum = 0;
    for (const d of streamState.durations) sum += d || 0;
    return sum;
  };

  const globalTime = () => {
    if (streamState) {
      return streamState.baseTime + (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    }
    return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  };

  const globalDuration = () => {
    if (streamState) return totalKnownDuration();
    return Number.isFinite(audio.duration) ? audio.duration : 0;
  };

  const updateTimeDisplay = () => {
    if (seeking) return;
    const cur = globalTime();
    const dur = globalDuration();
    seek.max = Math.max(0, dur).toString();
    seek.value = Math.max(0, Math.min(dur, cur)).toString();
    currentTimeEl.textContent = formatTime(cur);
    durationEl.textContent = formatTime(dur);
  };

  const fetchTextList = async () => {
    try {
      const res = await fetch("/api/texts");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      select.innerHTML = "";
      if (!data.texts.length) {
        const opt = document.createElement("option");
        opt.textContent = "(texts/ にテキストがありません)";
        opt.value = "";
        select.appendChild(opt);
        return;
      }
      for (const name of data.texts) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
      await loadSelectedText();
    } catch (err) {
      setStatus(`一覧の取得に失敗: ${err.message}`);
    }
  };

  const loadSelectedText = async () => {
    const name = select.value;
    if (!name) return;
    try {
      const res = await fetch(`/api/texts/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      textContent.value = data.content;
      setStatus(`${name} を読み込みました`);
    } catch (err) {
      setStatus(`読み込みに失敗: ${err.message}`);
    }
  };

  const fetchEngines = async () => {
    try {
      const res = await fetch("/api/engines");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      engines = data.engines || [];
      engineSelect.innerHTML = "";
      for (const e of engines) {
        const opt = document.createElement("option");
        opt.value = e.id;
        opt.textContent = e.available
          ? `${e.name}${e.device ? ` [${e.device}]` : ""}`
          : `${e.name} (未起動)`;
        opt.disabled = !e.available;
        engineSelect.appendChild(opt);
      }
      const saved = engines.find((e) => e.id === prefs.engine && e.available);
      const firstAvailable = engines.find((e) => e.available);
      const picked = saved || firstAvailable;
      if (picked) engineSelect.value = picked.id;
      await applyEngineSelection({ persist: !!saved });
    } catch (err) {
      setStatus(`エンジン一覧の取得に失敗: ${err.message}`);
    }
  };

  const applyEngineSelection = async ({ persist }) => {
    const id = engineSelect.value;
    if (persist) {
      prefs.engine = id;
      savePrefs({ engine: id });
    }
    const e = engines.find((x) => x.id === id);
    voiceRow.hidden = !(e && e.has_voices);
    voiceSelect.innerHTML = "";
    if (!e || !e.has_voices) return;
    try {
      const res = await fetch(`/api/engines/${id}/voices`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const v of data.voices) {
        const opt = document.createElement("option");
        opt.value = String(v.id);
        opt.textContent = v.name;
        voiceSelect.appendChild(opt);
      }
      const opts = Array.from(voiceSelect.options);
      let matched = null;
      if (prefs.voiceId !== null && prefs.voiceId !== undefined) {
        matched = opts.find((o) => o.value === String(prefs.voiceId)) || null;
      }
      if (!matched && prefs.voiceName) {
        const wanted = normalizeName(prefs.voiceName);
        matched = opts.find((o) => normalizeName(o.textContent) === wanted) || null;
      }
      if (matched) {
        voiceSelect.value = matched.value;
      } else if (opts.length) {
        voiceSelect.value = opts[0].value;
      }
    } catch (err) {
      setStatus(`話者一覧の取得に失敗: ${err.message}`);
    }
  };

  const onEngineChange = () => applyEngineSelection({ persist: true });

  const onVoiceChange = () => {
    const opt = voiceSelect.selectedOptions[0];
    if (!opt) return;
    prefs.voiceName = opt.textContent;
    prefs.voiceId = opt.value;
    savePrefs({ voiceName: opt.textContent, voiceId: opt.value });
  };

  const requestBody = () => {
    const text = textContent.value.trim();
    const engineId = engineSelect.value || "jvs";
    const speakerVal = voiceSelect.value ? Number(voiceSelect.value) : null;
    const body = { text, engine: engineId };
    if (speakerVal !== null && !Number.isNaN(speakerVal)) {
      body.speaker = speakerVal;
    }
    return body;
  };

  // ===== 一括合成モード =====
  const synthesizeAndLoad = async () => {
    stopStreaming();
    const body = requestBody();
    if (!body.text) {
      setStatus("テキストが空です");
      return;
    }
    loadBtn.disabled = true;
    streamBtn.disabled = true;
    setStatus("音声を合成中...");
    try {
      const res = await fetch("/api/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }
      const blob = await res.blob();
      if (audio.src && audio.src.startsWith("blob:")) {
        URL.revokeObjectURL(audio.src);
      }
      audio.src = URL.createObjectURL(blob);
      audio.load();
      applySpeed();
      setStatus("準備完了。▶ で再生");
    } catch (err) {
      setStatus(`合成に失敗: ${err.message}`);
    } finally {
      loadBtn.disabled = false;
      streamBtn.disabled = false;
    }
  };

  // ===== ストリーミングモード =====
  const stopStreaming = () => {
    if (!streamState) return;
    if (streamState.pollTimer) {
      clearTimeout(streamState.pollTimer);
    }
    streamState = null;
  };

  const renderStreamProgress = () => {
    if (!streamState) return;
    const readyCount = streamState.ready.filter(Boolean).length;
    const tail = streamState.done
      ? "合成完了"
      : streamState.error
      ? `エラー: ${streamState.error}`
      : "合成中";
    setStatus(`${tail} (${readyCount} / ${streamState.total} チャンク)`);
  };

  const pollStreamStatus = async () => {
    if (!streamState) return;
    try {
      const res = await fetch(`/api/stream/${streamState.sessionId}/status`);
      if (res.ok) {
        const data = await res.json();
        streamState.ready = data.ready;
        streamState.durations = data.durations;
        streamState.done = data.done;
        streamState.error = data.error;
        renderStreamProgress();
        updateTimeDisplay();
        maybePreloadNext();
      }
    } catch {
      // ignore, retry
    }
    if (streamState && !streamState.done) {
      streamState.pollTimer = setTimeout(pollStreamStatus, 1500);
    }
  };

  const chunkUrl = (idx, wait) =>
    `/api/stream/${streamState.sessionId}/chunk/${idx}${wait ? "?wait=true" : ""}`;

  const maybePreloadNext = () => {
    if (!streamState) return;
    const nextIdx = streamState.currentIdx + 1;
    if (nextIdx >= streamState.total) return;
    if (streamState.preloadedIdx === nextIdx) return;
    if (!streamState.ready[nextIdx]) return;
    // ブラウザキャッシュに事前取得
    fetch(chunkUrl(nextIdx, false)).catch(() => {});
    streamState.preloadedIdx = nextIdx;
  };

  const loadChunkIntoAudio = (idx) => {
    if (!streamState) return Promise.reject(new Error("no stream"));
    streamState.loadingIdx = idx;
    return new Promise((resolve, reject) => {
      const onLoaded = () => {
        audio.removeEventListener("loadedmetadata", onLoaded);
        audio.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        audio.removeEventListener("loadedmetadata", onLoaded);
        audio.removeEventListener("error", onError);
        reject(new Error("audio load error"));
      };
      audio.addEventListener("loadedmetadata", onLoaded, { once: true });
      audio.addEventListener("error", onError, { once: true });
      audio.src = chunkUrl(idx, true);
      audio.load();
    });
  };

  const advanceChunk = async () => {
    if (!streamState) return;
    const finishedIdx = streamState.currentIdx;
    streamState.baseTime += streamState.durations[finishedIdx] || 0;
    streamState.currentIdx++;
    if (streamState.currentIdx >= streamState.total) {
      setStatus("再生完了");
      playBtn.textContent = "▶";
      playBtn.classList.remove("playing");
      return;
    }
    try {
      await loadChunkIntoAudio(streamState.currentIdx);
      applySpeed();
      await audio.play();
      maybePreloadNext();
    } catch (err) {
      setStatus(`次チャンク再生失敗: ${err.message}`);
    }
  };

  const seekToGlobal = async (targetSec) => {
    if (!streamState) {
      if (Number.isFinite(audio.duration)) {
        audio.currentTime = Math.max(0, Math.min(audio.duration, targetSec));
      }
      return;
    }
    let remaining = Math.max(0, targetSec);
    let idx = 0;
    let base = 0;
    for (let i = 0; i < streamState.total; i++) {
      const d = streamState.durations[i];
      if (d === null || d === undefined) break;
      if (remaining < d) {
        idx = i;
        break;
      }
      remaining -= d;
      base += d;
      idx = i + 1;
    }
    if (idx >= streamState.total) {
      idx = streamState.total - 1;
      base = totalKnownDuration() - (streamState.durations[idx] || 0);
      remaining = streamState.durations[idx] || 0;
    }
    if (!streamState.ready[idx]) {
      setStatus(`チャンク ${idx + 1} を待機中...`);
    }
    const wasPlaying = !audio.paused;
    if (idx !== streamState.currentIdx) {
      streamState.currentIdx = idx;
      streamState.baseTime = base;
      try {
        await loadChunkIntoAudio(idx);
      } catch (err) {
        setStatus(`シーク失敗: ${err.message}`);
        return;
      }
    }
    const cap = Number.isFinite(audio.duration) ? audio.duration : remaining;
    audio.currentTime = Math.max(0, Math.min(cap, remaining));
    if (wasPlaying) {
      try {
        await audio.play();
      } catch {
        // ignore
      }
    }
    maybePreloadNext();
  };

  const startStreaming = async () => {
    const body = requestBody();
    if (!body.text) {
      setStatus("テキストが空です");
      return;
    }
    stopStreaming();
    ensureAudioGraph();
    await resumeAudioCtx();
    applyVolume();

    loadBtn.disabled = true;
    streamBtn.disabled = true;
    setStatus("ストリーミング開始中...");

    try {
      const res = await fetch("/api/stream/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }
      const data = await res.json();
      streamState = {
        sessionId: data.session_id,
        total: data.total,
        ready: data.ready || [],
        durations: data.durations || [],
        done: !!data.done,
        error: data.error || null,
        currentIdx: 0,
        baseTime: 0,
        loadingIdx: -1,
        preloadedIdx: -1,
      };
      renderStreamProgress();
      await loadChunkIntoAudio(0);
      applySpeed();
      try {
        await audio.play();
      } catch (err) {
        setStatus(`再生開始に失敗: ${err.message}`);
      }
      maybePreloadNext();
      pollStreamStatus();
    } catch (err) {
      setStatus(`ストリーミング失敗: ${err.message}`);
      stopStreaming();
    } finally {
      loadBtn.disabled = false;
      streamBtn.disabled = false;
    }
  };

  // ===== 共通再生コントロール =====
  const togglePlay = async () => {
    if (!audio.src) {
      setStatus("まず「このテキストを読み込む」または「ストリーミング再生」を押してください");
      return;
    }
    ensureAudioGraph();
    await resumeAudioCtx();
    applyVolume();
    if (audio.paused) {
      try {
        await audio.play();
      } catch (err) {
        setStatus(`再生に失敗: ${err.message}`);
      }
    } else {
      audio.pause();
    }
  };

  const skipBy = (seconds) => {
    if (streamState) {
      seekToGlobal(globalTime() + seconds);
      return;
    }
    if (!Number.isFinite(audio.duration)) return;
    const next = Math.min(audio.duration, Math.max(0, audio.currentTime + seconds));
    audio.currentTime = next;
  };

  // ===== イベント =====
  const readLocalFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      textContent.value = typeof reader.result === "string" ? reader.result : "";
      setStatus(`${file.name} を読み込みました (端末)`);
      select.value = "";
    };
    reader.onerror = () => {
      setStatus(`ファイル読み込み失敗: ${reader.error?.message || "unknown"}`);
    };
    reader.readAsText(file, "utf-8");
  };

  select.addEventListener("change", loadSelectedText);
  reloadBtn.addEventListener("click", fetchTextList);
  localFileBtn.addEventListener("click", () => localFileInput.click());
  localFileInput.addEventListener("change", () => {
    const file = localFileInput.files && localFileInput.files[0];
    readLocalFile(file);
    localFileInput.value = "";
  });
  loadBtn.addEventListener("click", synthesizeAndLoad);
  streamBtn.addEventListener("click", startStreaming);
  playBtn.addEventListener("click", togglePlay);
  engineSelect.addEventListener("change", onEngineChange);
  voiceSelect.addEventListener("change", onVoiceChange);

  document.querySelectorAll("[data-skip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      skipBy(Number(btn.dataset.skip));
    });
  });

  speedRange.addEventListener("input", applySpeed);
  speedRange.addEventListener("change", applySpeed);

  volumeRange.addEventListener("input", () => {
    if (muted && Number(volumeRange.value) > 0) muted = false;
    applyVolume();
  });
  volumeRange.addEventListener("change", applyVolume);
  muteBtn.addEventListener("click", toggleMute);

  audio.addEventListener("loadedmetadata", () => {
    applySpeed();
    updateTimeDisplay();
  });
  audio.addEventListener("timeupdate", updateTimeDisplay);
  audio.addEventListener("durationchange", updateTimeDisplay);
  audio.addEventListener("play", () => {
    playBtn.textContent = "❚❚";
    playBtn.classList.add("playing");
    applySpeed();
  });
  audio.addEventListener("pause", () => {
    playBtn.textContent = "▶";
    playBtn.classList.remove("playing");
  });
  audio.addEventListener("ended", () => {
    if (streamState) {
      advanceChunk();
      return;
    }
    playBtn.textContent = "▶";
    playBtn.classList.remove("playing");
  });
  audio.addEventListener("ratechange", () => {
    const rate = clampSpeed(audio.playbackRate);
    speedLabel.textContent = `${rate.toFixed(1)}x`;
  });

  const beginSeek = () => {
    seeking = true;
  };
  const commitSeek = () => {
    if (globalDuration() <= 0) {
      seeking = false;
      return;
    }
    const target = Number(seek.value);
    seeking = false;
    seekToGlobal(target);
  };
  seek.addEventListener("pointerdown", beginSeek);
  seek.addEventListener("pointerup", commitSeek);
  seek.addEventListener("touchstart", beginSeek, { passive: true });
  seek.addEventListener("touchend", commitSeek);
  seek.addEventListener("input", () => {
    currentTimeEl.textContent = formatTime(Number(seek.value));
  });
  seek.addEventListener("change", commitSeek);

  applySpeed();
  applyVolume();
  fetchEngines();
  fetchTextList();
})();
