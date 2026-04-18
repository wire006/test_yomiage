(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const select = $("text-select");
  const reloadBtn = $("reload-btn");
  const textContent = $("text-content");
  const loadBtn = $("load-btn");
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
  const statusEl = $("status");

  let seeking = false;
  let muted = false;
  let audioCtx = null;
  let gainNode = null;

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

  const synthesizeAndLoad = async () => {
    const text = textContent.value.trim();
    if (!text) {
      setStatus("テキストが空です");
      return;
    }
    loadBtn.disabled = true;
    setStatus("音声を合成中...");
    try {
      const res = await fetch("/api/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
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
    }
  };

  const togglePlay = async () => {
    if (!audio.src) {
      setStatus("まず「このテキストを読み込む」を押してください");
      return;
    }
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch {
        // ignore
      }
    }
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
    if (!Number.isFinite(audio.duration)) return;
    const next = Math.min(
      audio.duration,
      Math.max(0, audio.currentTime + seconds),
    );
    audio.currentTime = next;
  };

  select.addEventListener("change", loadSelectedText);
  reloadBtn.addEventListener("click", fetchTextList);
  loadBtn.addEventListener("click", synthesizeAndLoad);
  playBtn.addEventListener("click", togglePlay);

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
    seek.max = audio.duration.toString();
    durationEl.textContent = formatTime(audio.duration);
    applySpeed();
  });
  audio.addEventListener("timeupdate", () => {
    if (seeking) return;
    seek.value = audio.currentTime.toString();
    currentTimeEl.textContent = formatTime(audio.currentTime);
  });
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
    if (!Number.isFinite(audio.duration)) {
      seeking = false;
      return;
    }
    audio.currentTime = Number(seek.value);
    currentTimeEl.textContent = formatTime(audio.currentTime);
    seeking = false;
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
  fetchTextList();
})();
