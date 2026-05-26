/* ═══════════════════════════════════════════════════════════════
   Qwen3-TTS Studio — Frontend Controller
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener("DOMContentLoaded", () => {
  // ── State ───────────────────────────────────────────────────
  let config = null;
  let activeModelKey = null;
  let activeMode = null; // 'custom', 'design', 'clone_saved', 'clone_quick'
  let savedVoices = [];
  let selectedVoice = null;
  let quickCloneAudioPath = null;
  let currentEventSource = null;

  // ── DOM Cache ────────────────────────────────────────────────
  const modelNav = document.getElementById("model-nav");
  const statusDot = document.getElementById("status-dot");
  const statusLabel = document.getElementById("status-label");
  const topbarTitle = document.getElementById("topbar-title");
  const topbarBadge = document.getElementById("topbar-badge");
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  
  const modeTabsContainer = document.getElementById("mode-tabs");
  const controlsBody = document.getElementById("controls-body");
  
  const audioCard = document.getElementById("audio-card");
  const audioFilename = document.getElementById("audio-filename");
  const audioDownload = document.getElementById("audio-download");
  const audioPlayer = document.getElementById("audio-player");
  const logScroll = document.getElementById("log-scroll");
  const clearLogBtn = document.getElementById("clear-log-btn");
  
  // Drawer & Enroll
  const drawerBackdrop = document.getElementById("drawer-backdrop");
  const voiceDrawer = document.getElementById("voice-drawer");
  const closeDrawerBtn = document.getElementById("close-drawer-btn");
  const enrollToggleBtn = document.getElementById("enroll-toggle-btn");
  const enrollForm = document.getElementById("enroll-form");
  const enrollDrop = document.getElementById("enroll-drop");
  const enrollDropLabel = document.getElementById("enroll-drop-label");
  const enrollFile = document.getElementById("enroll-file");
  const enrollName = document.getElementById("enroll-name");
  const enrollTranscript = document.getElementById("enroll-transcript");
  const enrollSubmitBtn = document.getElementById("enroll-submit-btn");
  const enrollStatus = document.getElementById("enroll-status");

  // History Drawer
  const historyToggleBtn = document.getElementById("history-toggle-btn");
  const historyDrawer = document.getElementById("history-drawer");
  const closeHistoryBtn = document.getElementById("close-history-btn");
  const historyBody = document.getElementById("history-body");

  // ── Initialization ──────────────────────────────────────────
  async function init() {
    updateStatus("Connecting…", "info");
    try {
      const response = await fetch("/api/config");
      config = await response.json();
      updateStatus("Online", "ok");
      
      await loadSavedVoices();
      renderSidebar();
      setupGlobalListeners();
      startPingLoop();
    } catch (err) {
      console.error("Initialization error:", err);
      updateStatus("Offline", "err");
      logLine("error", "Failed to connect to the server. Make sure app.py is running.");
      startPingLoop(); // still poll in case it comes online
    }
  }

  function startPingLoop() {
    setInterval(async () => {
      try {
        const res = await fetch("/api/ping");
        if (res.ok) updateStatus("Online", "ok");
        else throw new Error("not ok");
      } catch (err) {
        updateStatus("Offline", "err");
      }
    }, 5000);
  }

  // ── Render Helpers ──────────────────────────────────────────
  function updateStatus(text, status) {
    statusLabel.textContent = text;
    statusDot.className = "status-dot " + (status === "ok" ? "ok" : status === "err" ? "err" : "");
  }

  function logLine(type, text) {
    // Remove empty placeholder if present
    const emptyLog = logScroll.querySelector(".log-empty");
    if (emptyLog) emptyLog.remove();

    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    line.textContent = text;
    logScroll.appendChild(line);
    logScroll.scrollTop = logScroll.scrollHeight;
  }

  function clearLogs() {
    logScroll.innerHTML = '<div class="log-empty">No output yet.</div>';
  }

  async function loadSavedVoices() {
    try {
      const res = await fetch("/api/voices");
      const data = await res.json();
      savedVoices = data.voices || [];
    } catch (err) {
      console.error("Failed to load voices:", err);
    }
  }

  function renderSidebar() {
    modelNav.innerHTML = "";
    
    // Group models by Pro and Lite
    const proModels = [];
    const liteModels = [];

    Object.entries(config.models).forEach(([key, info]) => {
      // Pro models are typically 1, 2, 3
      if (parseInt(key) <= 3) {
        proModels.push({ key, ...info });
      } else {
        liteModels.push({ key, ...info });
      }
    });

    const buildGroup = (label, list) => {
      const header = document.createElement("div");
      header.className = "nav-group-label";
      header.textContent = label;
      modelNav.appendChild(header);

      list.forEach(m => {
        const item = document.createElement("button");
        item.className = "nav-item" + (m.available ? "" : " unavailable");
        item.setAttribute("role", "menuitem");
        
        let modeLabel = m.name;
        let icon = "🎙";
        if (m.mode === "design") { icon = "🎨"; }
        if (m.mode === "clone_manager") { icon = "👥"; }

        item.innerHTML = `
          <span class="nav-item-icon">${icon}</span>
          <span>${modeLabel}</span>
          <span class="nav-item-meta">${m.available ? "Loaded" : "Missing"}</span>
        `;

        if (m.available) {
          item.addEventListener("click", () => {
            document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            item.classList.add("active");
            selectModel(m.key);
            if (window.innerWidth <= 680) {
              sidebar.classList.remove("open");
            }
          });
        }
        modelNav.appendChild(item);
      });
    };

    buildGroup("Pro Models (1.7B)", proModels);
    buildGroup("Lite Models (0.6B)", liteModels);
  }

  function selectModel(key) {
    activeModelKey = key;
    const model = config.models[key];
    
    topbarTitle.textContent = `${model.name} (${model.folder.includes("1.7B") ? "1.7B Pro" : "0.6B Lite"})`;
    topbarBadge.textContent = model.mode.toUpperCase();

    // Default modes
    if (model.mode === "custom") {
      activeMode = "custom";
      renderCustomModeForm();
    } else if (model.mode === "design") {
      activeMode = "design";
      renderDesignModeForm();
    } else if (model.mode === "clone_manager") {
      activeMode = "clone_saved"; // default sub-mode for cloning
      renderCloneModeTabs();
      renderCloneModeForm();
    }
  }

  // ── Mode Forms ──────────────────────────────────────────────
  function renderCustomModeForm() {
    modeTabsContainer.innerHTML = ""; // No extra mode tabs needed for custom

    const speakers = config.speaker_map;
    let selectedSpeaker = null;
    let selectedSpeed = 1.0;

    controlsBody.innerHTML = `
      <div class="field-group">
        <label class="field-label">Speaker</label>
        <div class="chip-group" id="speaker-chips"></div>
      </div>
      <div class="field-group">
        <label class="field-label">
          Emotion/Tone Instruction 
          <span class="hint">(e.g. Whispering, Sad and crying, excited)</span>
        </label>
        <input type="text" id="custom-instruct" placeholder="Normal tone" />
        <div class="emotion-pills" id="emotion-pills"></div>
      </div>
      <div class="field-group">
        <label class="field-label">Speed</label>
        <div class="chip-group" id="speed-chips"></div>
      </div>
      <div class="field-group">
        <label class="field-label">Text to Speak</label>
        <textarea id="tts-text" placeholder="Type text here to generate audio..."></textarea>
      </div>
      <div class="generate-row">
        <button class="btn btn-primary" id="generate-btn">
          <span>Generate Voice</span>
        </button>
      </div>
    `;

    // Render Speaker Chips grouped by Language
    const speakerContainer = document.getElementById("speaker-chips");
    Object.entries(speakers).forEach(([lang, names]) => {
      const groupLabel = document.createElement("div");
      groupLabel.className = "speaker-lang-label";
      groupLabel.textContent = lang;
      speakerContainer.appendChild(groupLabel);

      names.forEach(name => {
        const chip = document.createElement("button");
        chip.className = "chip";
        chip.textContent = name;
        chip.addEventListener("click", () => {
          speakerContainer.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
          chip.classList.add("selected");
          selectedSpeaker = name;
        });
        speakerContainer.appendChild(chip);
        if (!selectedSpeaker) {
          chip.click(); // Select first speaker by default
        }
      });
    });

    // Emotion Pills
    const emotionContainer = document.getElementById("emotion-pills");
    const instructInput = document.getElementById("custom-instruct");
    config.emotion_examples.forEach(ex => {
      const pill = document.createElement("button");
      pill.className = "emotion-pill";
      pill.textContent = ex;
      pill.addEventListener("click", () => {
        instructInput.value = ex;
      });
      emotionContainer.appendChild(pill);
    });

    // Speed Chips
    const speedContainer = document.getElementById("speed-chips");
    config.speeds.forEach(sp => {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = sp.label;
      if (sp.value === 1.0) chip.classList.add("selected");
      chip.addEventListener("click", () => {
        speedContainer.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
        chip.classList.add("selected");
        selectedSpeed = sp.value;
      });
      speedContainer.appendChild(chip);
    });

    document.getElementById("generate-btn").addEventListener("click", () => {
      const text = document.getElementById("tts-text").value;
      const instruct = instructInput.value;
      triggerGeneration({
        model_key: activeModelKey,
        mode: "custom",
        text,
        speaker: selectedSpeaker,
        instruct: instruct || "Normal tone",
        speed: selectedSpeed
      });
    });
  }

  function renderDesignModeForm() {
    modeTabsContainer.innerHTML = "";

    controlsBody.innerHTML = `
      <div class="field-group">
        <label class="field-label">
          Voice Description
          <span class="hint">(Describe what you want the voice to sound like)</span>
        </label>
        <textarea id="design-instruct" rows="3" placeholder="A middle-aged man with a deep, raspy voice, speaking with high enthusiasm..."></textarea>
      </div>
      <div class="field-group">
        <label class="field-label">Text to Speak</label>
        <textarea id="tts-text" placeholder="Type text here to generate audio..."></textarea>
      </div>
      <div class="generate-row">
        <button class="btn btn-primary" id="generate-btn">
          <span>Generate Voice</span>
        </button>
      </div>
    `;

    document.getElementById("generate-btn").addEventListener("click", () => {
      const text = document.getElementById("tts-text").value;
      const instruct = document.getElementById("design-instruct").value;
      triggerGeneration({
        model_key: activeModelKey,
        mode: "design",
        text,
        instruct
      });
    });
  }

  function renderCloneModeTabs() {
    modeTabsContainer.innerHTML = `
      <button class="mode-tab active" id="tab-clone-saved">Saved Voices</button>
      <button class="mode-tab" id="tab-clone-quick">Quick Clone</button>
    `;

    document.getElementById("tab-clone-saved").addEventListener("click", (e) => {
      document.querySelectorAll(".mode-tab").forEach(t => t.classList.remove("active"));
      e.target.classList.add("active");
      activeMode = "clone_saved";
      renderCloneModeForm();
    });

    document.getElementById("tab-clone-quick").addEventListener("click", (e) => {
      document.querySelectorAll(".mode-tab").forEach(t => t.classList.remove("active"));
      e.target.classList.add("active");
      activeMode = "clone_quick";
      renderCloneModeForm();
    });
  }

  function renderCloneModeForm() {
    if (activeMode === "clone_saved") {
      controlsBody.innerHTML = `
        <div class="field-group">
          <label class="field-label">Cloned Voice Profile</label>
          <div class="voice-select-card" id="voice-select-card">
            <div class="voice-avatar">👤</div>
            <div class="voice-name" id="selected-voice-name">Select from Library...</div>
            <div class="voice-change">Browse</div>
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">Text to Speak</label>
          <textarea id="tts-text" placeholder="Type text here to generate audio..."></textarea>
        </div>
        <div class="generate-row">
          <button class="btn btn-primary" id="generate-btn" disabled>
            <span>Generate Voice</span>
          </button>
        </div>
      `;

      const selectCard = document.getElementById("voice-select-card");
      selectCard.addEventListener("click", openVoiceLibrary);

      if (selectedVoice) {
        document.getElementById("selected-voice-name").textContent = selectedVoice;
        document.getElementById("generate-btn").disabled = false;
      }

      document.getElementById("generate-btn").addEventListener("click", () => {
        const text = document.getElementById("tts-text").value;
        triggerGeneration({
          model_key: activeModelKey,
          mode: "clone_saved",
          text,
          voice_name: selectedVoice
        });
      });

    } else if (activeMode === "clone_quick") {
      controlsBody.innerHTML = `
        <div class="field-group">
          <label class="field-label">Reference Audio File</label>
          <div class="file-drop" id="quick-drop" tabindex="0" role="button">
            <span id="quick-drop-label">Drag &amp; drop reference WAV, MP3 etc.</span>
            <input type="file" id="quick-file" accept="audio/*" hidden />
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">Transcript <span class="hint">(Highly recommended for quality)</span></label>
          <input type="text" id="quick-transcript" placeholder="What is being said in the reference audio?" />
        </div>
        <div class="field-group">
          <label class="field-label">Text to Speak</label>
          <textarea id="tts-text" placeholder="Type text here to generate audio..."></textarea>
        </div>
        <div class="generate-row">
          <button class="btn btn-primary" id="generate-btn" disabled>
            <span>Generate Voice</span>
          </button>
        </div>
      `;

      setupQuickCloneUpload();

      document.getElementById("generate-btn").addEventListener("click", () => {
        const text = document.getElementById("tts-text").value;
        const refText = document.getElementById("quick-transcript").value;
        triggerGeneration({
          model_key: activeModelKey,
          mode: "clone_quick",
          text,
          ref_audio_path: quickCloneAudioPath,
          ref_text: refText
        });
      });
    }
  }

  // ── Generation Logic ────────────────────────────────────────
  function triggerGeneration(payload) {
    if (currentEventSource) {
      currentEventSource.close();
    }

    // Input Validation
    if (!payload.text.trim()) {
      alert("Please enter text to generate.");
      return;
    }

    clearLogs();
    logLine("info", "Starting generation...");
    
    const genBtn = document.getElementById("generate-btn");
    const originalBtnHTML = genBtn.innerHTML;
    genBtn.disabled = true;
    genBtn.innerHTML = `<span class="spinner"></span> <span>Generating…</span>`;

    fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      // Handle EventStream response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) {
            cleanup();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop();

          parts.forEach(part => {
            const lines = part.split("\n");
            let event = null;
            let data = null;
            lines.forEach(line => {
              if (line.startsWith("event: ")) {
                event = line.replace("event: ", "").trim();
              } else if (line.startsWith("data: ")) {
                try {
                  data = JSON.parse(line.replace("data: ", "").trim());
                } catch(e) {
                  data = line.replace("data: ", "").trim();
                }
              }
            });

            if (event && data !== null) {
              handleGenEvent(event, data);
            }
          });

          read();
        }).catch(err => {
          logLine("error", "Stream interrupted: " + err.message);
          cleanup();
        });
      }

      read();
    })
    .catch(err => {
      logLine("error", "Failed to start generation: " + err.message);
      cleanup();
    });

    function cleanup() {
      genBtn.disabled = false;
      genBtn.innerHTML = originalBtnHTML;
    }
  }

  function handleGenEvent(event, data) {
    if (event === "info") {
      logLine("info", data);
    } else if (event === "done") {
      logLine("done", "Generation finished! Audio saved successfully.");
      showAudioPlayer(data);
    } else if (event === "error") {
      logLine("error", "Generation failed: " + data);
    }
  }

  function showAudioPlayer(audioUrl) {
    audioCard.hidden = false;
    audioPlayer.src = audioUrl;
    
    const parts = audioUrl.split("/");
    audioFilename.textContent = parts[parts.length - 1];
    audioDownload.href = audioUrl;
    
    // Auto play in browser
    audioPlayer.play().catch(e => {
      console.log("Auto-play prevented by browser policy. User interaction required.");
    });
  }

  // ── Voice Library Drawer ────────────────────────────────────
  function openVoiceLibrary() {
    drawerBackdrop.hidden = false;
    voiceDrawer.hidden = false;
    renderVoiceLibrary();
  }

  function closeVoiceLibrary() {
    drawerBackdrop.hidden = true;
    voiceDrawer.hidden = true;
    enrollForm.hidden = true;
    enrollToggleBtn.textContent = "+ Enroll New Voice";
  }

  function renderVoiceLibrary() {
    const container = document.getElementById("voice-library-body");
    container.innerHTML = "";

    if (savedVoices.length === 0) {
      container.innerHTML = `<div class="voice-no-voices">No enrolled voices. Create one below.</div>`;
      return;
    }

    savedVoices.forEach(voice => {
      const item = document.createElement("div");
      item.className = "voice-library-item" + (selectedVoice === voice ? " selected" : "");
      
      item.innerHTML = `
        <div class="voice-avatar">👤</div>
        <div class="voice-item-name">${voice}</div>
        <button class="voice-item-delete" title="Delete Profile" aria-label="Delete">✕</button>
      `;

      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("voice-item-delete")) {
          e.stopPropagation();
          deleteVoice(voice);
        } else {
          selectedVoice = voice;
          closeVoiceLibrary();
          if (activeMode === "clone_saved") {
            renderCloneModeForm();
          }
        }
      });

      container.appendChild(item);
    });
  }

  async function deleteVoice(name) {
    if (!confirm(`Are you sure you want to delete the voice profile "${name}"?`)) return;
    try {
      const res = await fetch(`/api/voices/${name}`, { method: "DELETE" });
      const data = await res.json();
      if (data.deleted) {
        if (selectedVoice === name) selectedVoice = null;
        await loadSavedVoices();
        renderVoiceLibrary();
        if (activeMode === "clone_saved") {
          renderCloneModeForm();
        }
      }
    } catch(err) {
      alert("Failed to delete voice: " + err.message);
    }
  }

  // ── Output History Drawer ───────────────────────────────────
  function openHistoryDrawer() {
    drawerBackdrop.hidden = false;
    historyDrawer.hidden = false;
    renderHistoryDrawer();
  }

  function closeHistoryDrawer() {
    drawerBackdrop.hidden = true;
    historyDrawer.hidden = true;
  }

  async function renderHistoryDrawer() {
    historyBody.innerHTML = '<div class="voice-no-voices">Loading...</div>';
    try {
      const res = await fetch("/api/outputs");
      const data = await res.json();
      const outputs = data.outputs || [];

      if (outputs.length === 0) {
        historyBody.innerHTML = '<div class="voice-no-voices">No generated audio yet.</div>';
        return;
      }

      historyBody.innerHTML = "";
      
      const byFolder = {};
      outputs.forEach(output => {
        if (!byFolder[output.folder]) byFolder[output.folder] = [];
        byFolder[output.folder].push(output);
      });

      for (const [folder, files] of Object.entries(byFolder)) {
        const groupHeader = document.createElement("div");
        groupHeader.className = "history-group-label";
        groupHeader.textContent = folder;
        historyBody.appendChild(groupHeader);

        files.forEach(output => {
          const item = document.createElement("div");
          item.className = "history-item";
          
          const sizeMb = (output.size / (1024 * 1024)).toFixed(2);
          const dateStr = new Date(output.created * 1000).toLocaleString();

          item.innerHTML = `
            <div class="history-header">
              <div class="history-filename">${output.filename}</div>
              <button class="history-delete" title="Delete File" aria-label="Delete">✕</button>
            </div>
            <div class="history-meta">
              <span>${sizeMb} MB</span>
              <span>•</span>
              <span>${dateStr}</span>
            </div>
            <div class="history-controls">
              <audio class="history-audio" controls src="/outputs/${output.path}"></audio>
              <a href="/outputs/${output.path}" download class="btn-icon" title="Download">⬇</a>
            </div>
          `;

          item.querySelector(".history-delete").addEventListener("click", () => {
            deleteOutput(output.path);
          });

          historyBody.appendChild(item);
        });
      }
    } catch (err) {
      historyBody.innerHTML = '<div class="voice-no-voices" style="color:var(--accent-err)">Failed to load outputs.</div>';
    }
  }

  async function deleteOutput(path) {
    if (!confirm("Are you sure you want to delete this file?")) return;
    try {
      const res = await fetch(`/api/outputs/${encodeURIComponent(path)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.deleted) {
        renderHistoryDrawer(); // refresh list
      }
    } catch(err) {
      alert("Failed to delete file: " + err.message);
    }
  }


  // ── File Upload / Drag & Drop ───────────────────────────────
  function setupQuickCloneUpload() {
    const dropZone = document.getElementById("quick-drop");
    const fileInput = document.getElementById("quick-file");
    const dropLabel = document.getElementById("quick-drop-label");
    const genBtn = document.getElementById("generate-btn");

    if (quickCloneAudioPath) {
      dropLabel.textContent = "Reference file uploaded!";
      dropZone.style.borderColor = "var(--accent-ok)";
      genBtn.disabled = false;
    }

    dropZone.addEventListener("click", () => fileInput.click());
    
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-over");
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("drag-over");
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
      if (e.dataTransfer.files.length) {
        handleFileSelect(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target.files.length) {
        handleFileSelect(e.target.files[0]);
      }
    });

    async function handleFileSelect(file) {
      dropLabel.textContent = "Uploading & converting…";
      const formData = new FormData();
      formData.append("audio", file);

      try {
        const res = await fetch("/api/upload_ref", {
          method: "POST",
          body: formData
        });
        const data = await res.json();
        if (data.ref_audio_path) {
          quickCloneAudioPath = data.ref_audio_path;
          dropLabel.textContent = `Uploaded: ${file.name}`;
          dropZone.style.borderColor = "var(--accent-ok)";
          genBtn.disabled = false;
        } else {
          throw new Error(data.error || "Unknown error");
        }
      } catch (err) {
        dropLabel.textContent = "Upload failed. Try another audio file.";
        dropZone.style.borderColor = "var(--accent-err)";
        alert("Upload failed: " + err.message);
      }
    }
  }

  function setupEnrollUpload() {
    let selectedFile = null;

    enrollDrop.addEventListener("click", () => enrollFile.click());
    
    enrollDrop.addEventListener("dragover", (e) => {
      e.preventDefault();
      enrollDrop.classList.add("drag-over");
    });

    enrollDrop.addEventListener("dragleave", () => {
      enrollDrop.classList.remove("drag-over");
    });

    enrollDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      enrollDrop.classList.remove("drag-over");
      if (e.dataTransfer.files.length) {
        setEnrollFile(e.dataTransfer.files[0]);
      }
    });

    enrollFile.addEventListener("change", (e) => {
      if (e.target.files.length) {
        setEnrollFile(e.target.files[0]);
      }
    });

    function setEnrollFile(file) {
      selectedFile = file;
      enrollDropLabel.textContent = `Selected: ${file.name}`;
      enrollDrop.style.borderColor = "var(--accent-b)";
    }

    enrollSubmitBtn.addEventListener("click", async () => {
      const name = enrollName.value.trim();
      const transcript = enrollTranscript.value.trim();

      if (!name || !selectedFile) {
        enrollStatus.className = "enroll-status err";
        enrollStatus.textContent = "Name and reference audio are required.";
        return;
      }

      enrollStatus.className = "enroll-status";
      enrollStatus.textContent = "Enrolling voice profile...";
      enrollSubmitBtn.disabled = true;

      const formData = new FormData();
      formData.append("name", name);
      formData.append("transcript", transcript);
      formData.append("audio", selectedFile);

      try {
        const res = await fetch("/api/enroll", {
          method: "POST",
          body: formData
        });
        const data = await res.json();
        if (data.enrolled) {
          enrollStatus.className = "enroll-status ok";
          enrollStatus.textContent = `Enrolled "${name}"!`;
          
          // Clear inputs
          enrollName.value = "";
          enrollTranscript.value = "";
          selectedFile = null;
          enrollDropLabel.textContent = "Drag & drop or click to browse";
          enrollDrop.style.borderColor = "var(--border)";

          await loadSavedVoices();
          renderVoiceLibrary();
          if (activeMode === "clone_saved") {
            renderCloneModeForm();
          }
        } else {
          throw new Error(data.error || "Unknown error");
        }
      } catch (err) {
        enrollStatus.className = "enroll-status err";
        enrollStatus.textContent = "Enrollment failed: " + err.message;
      } finally {
        enrollSubmitBtn.disabled = false;
      }
    });
  }

  // ── Global Listeners ────────────────────────────────────────
  function setupGlobalListeners() {
    // Sidebar toggle for mobile
    sidebarToggle.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });

    // Close sidebar if clicking outside on mobile
    document.addEventListener("click", (e) => {
      if (window.innerWidth <= 680) {
        if (!sidebar.contains(e.target) && !sidebarToggle.contains(e.target) && sidebar.classList.contains("open")) {
          sidebar.classList.remove("open");
        }
      }
    });

    // Drawer toggles
    closeDrawerBtn.addEventListener("click", closeVoiceLibrary);
    closeHistoryBtn.addEventListener("click", closeHistoryDrawer);
    historyToggleBtn.addEventListener("click", openHistoryDrawer);
    
    drawerBackdrop.addEventListener("click", () => {
      closeVoiceLibrary();
      closeHistoryDrawer();
    });

    enrollToggleBtn.addEventListener("click", () => {
      const hidden = enrollForm.hidden;
      enrollForm.hidden = !hidden;
      enrollToggleBtn.textContent = hidden ? "Cancel Enrollment" : "+ Enroll New Voice";
    });

    clearLogBtn.addEventListener("click", clearLogs);

    setupEnrollUpload();
  }

  // Run App
  init();
});
