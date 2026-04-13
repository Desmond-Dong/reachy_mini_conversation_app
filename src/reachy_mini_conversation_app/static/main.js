async function fetchStatus() {
  try {
    const url = new URL("/status", window.location.origin);
    url.searchParams.set("_", Date.now().toString());
    const resp = await fetchWithTimeout(url, {}, 2000);
    if (!resp.ok) throw new Error("status error");
    return await resp.json();
  } catch (e) {
    return { has_key: false, error: true };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function waitForStatus(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const url = new URL("/status", window.location.origin);
      url.searchParams.set("_", Date.now().toString());
      const resp = await fetchWithTimeout(url, {}, 2000);
      if (resp.ok) return await resp.json();
    } catch (e) {}
    if (Date.now() >= deadline) return null;
    await sleep(500);
  }
}

async function waitForPersonalityData(timeoutMs = 15000) {
  const loadingText = document.querySelector("#loading p");
  let attempts = 0;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    attempts += 1;
    try {
      const url = new URL("/personalities", window.location.origin);
      url.searchParams.set("_", Date.now().toString());
      const resp = await fetchWithTimeout(url, {}, 2000);
      if (resp.ok) return await resp.json();
    } catch (e) {}

    if (loadingText) {
      loadingText.textContent = attempts > 8 ? "Starting backend…" : "Loading…";
    }
    if (Date.now() >= deadline) return null;
    await sleep(500);
  }
}

async function validateKey(key) {
  const body = { openai_api_key: key };
  const resp = await fetch("/validate_api_key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || "validation_failed");
  }
  return data;
}

async function saveKey(key) {
  const body = { openai_api_key: key };
  const resp = await fetch("/openai_api_key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || "save_failed");
  }
  return await resp.json();
}

async function getHomeAssistantConfig() {
  const url = new URL("/home_assistant_config", window.location.origin);
  url.searchParams.set("_", Date.now().toString());
  const resp = await fetchWithTimeout(url, {}, 3000);
  if (!resp.ok) throw new Error("home_assistant_load_failed");
  return await resp.json();
}

async function saveHomeAssistantConfig(payload) {
  const resp = await fetch("/home_assistant_config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || "home_assistant_save_failed");
  }
  return data;
}

// ---------- Personalities API ----------
async function getPersonalities() {
  const url = new URL("/personalities", window.location.origin);
  url.searchParams.set("_", Date.now().toString());
  const resp = await fetchWithTimeout(url, {}, 2000);
  if (!resp.ok) throw new Error("list_failed");
  return await resp.json();
}

async function loadPersonality(name) {
  const url = new URL("/personalities/load", window.location.origin);
  url.searchParams.set("name", name);
  url.searchParams.set("_", Date.now().toString());
  const resp = await fetchWithTimeout(url, {}, 3000);
  if (!resp.ok) throw new Error("load_failed");
  return await resp.json();
}

async function savePersonality(payload) {
  // Try JSON POST first
  const saveUrl = new URL("/personalities/save", window.location.origin);
  saveUrl.searchParams.set("_", Date.now().toString());
  let resp = await fetchWithTimeout(saveUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, 5000);
  if (resp.ok) return await resp.json();

  // Fallback to form-encoded POST
  try {
    const form = new URLSearchParams();
    form.set("name", payload.name || "");
    form.set("instructions", payload.instructions || "");
    form.set("tools_text", payload.tools_text || "");
    form.set("voice", payload.voice || "cedar");
    const url = new URL("/personalities/save_raw", window.location.origin);
    url.searchParams.set("_", Date.now().toString());
    resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }, 5000);
    if (resp.ok) return await resp.json();
  } catch {}

  // Fallback to GET (query params)
  try {
    const url = new URL("/personalities/save_raw", window.location.origin);
    url.searchParams.set("name", payload.name || "");
    url.searchParams.set("instructions", payload.instructions || "");
    url.searchParams.set("tools_text", payload.tools_text || "");
    url.searchParams.set("voice", payload.voice || "cedar");
    url.searchParams.set("_", Date.now().toString());
    resp = await fetchWithTimeout(url, { method: "GET" }, 5000);
    if (resp.ok) return await resp.json();
  } catch {}

  const data = await resp.json().catch(() => ({}));
  throw new Error(data.error || "save_failed");
}

async function applyPersonality(name, { persist = false } = {}) {
  // Send as query param to avoid any body parsing issues on the server
  const url = new URL("/personalities/apply", window.location.origin);
  url.searchParams.set("name", name || "");
  if (persist) {
    url.searchParams.set("persist", "1");
  }
  url.searchParams.set("_", Date.now().toString());
  const resp = await fetchWithTimeout(url, { method: "POST" }, 5000);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || "apply_failed");
  }
  return await resp.json();
}

// Full list from https://developers.openai.com/api/docs/guides/text-to-speech/#voice-options
// "marin" and "cedar" are recommended for gpt-realtime.
const VOICE_FALLBACK = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"];

async function getVoices() {
  try {
    const url = new URL("/voices", window.location.origin);
    url.searchParams.set("_", Date.now().toString());
    const resp = await fetchWithTimeout(url, {}, 3000);
    if (!resp.ok) throw new Error("voices_failed");
    return await resp.json();
  } catch (e) {
    return VOICE_FALLBACK;
  }
}

function show(el, flag) {
  el.classList.toggle("hidden", !flag);
}

async function init() {
  const loading = document.getElementById("loading");
  show(loading, true);
  const statusEl = document.getElementById("status");
  const formPanel = document.getElementById("form-panel");
  const configuredPanel = document.getElementById("configured");
  const personalityPanel = document.getElementById("personality-panel");
  const homeAssistantPanel = document.getElementById("home-assistant-panel");
  const saveBtn = document.getElementById("save-btn");
  const changeKeyBtn = document.getElementById("change-key-btn");
  const input = document.getElementById("api-key");
  const haEnabled = document.getElementById("ha-enabled");
  const haFields = document.getElementById("ha-fields");
  const haUrl = document.getElementById("ha-url");
  const haToken = document.getElementById("ha-token");
  const haTokenNote = document.getElementById("ha-token-note");
  const haSave = document.getElementById("save-home-assistant");
  const haStatus = document.getElementById("home-assistant-status");

  // Personality elements
  const pSelect = document.getElementById("personality-select");
  const pApply = document.getElementById("apply-personality");
  const pPersist = document.getElementById("persist-personality");
  const pNew = document.getElementById("new-personality");
  const pSave = document.getElementById("save-personality");
  const pStartupLabel = document.getElementById("startup-label");
  const pName = document.getElementById("personality-name");
  const pInstr = document.getElementById("instructions-ta");
  const pTools = document.getElementById("tools-ta");
  const pStatus = document.getElementById("personality-status");
  const pVoice = document.getElementById("voice-select");
  const pAvail = document.getElementById("tools-available");

  const AUTO_WITH = {
    dance: ["stop_dance"],
    play_emotion: ["stop_emotion"],
  };

  statusEl.textContent = "Checking configuration...";
  show(formPanel, false);
  show(configuredPanel, false);
  show(homeAssistantPanel, false);
  show(personalityPanel, false);

  const st = (await waitForStatus()) || { has_key: false };
  if (st.has_key) {
    statusEl.textContent = "";
    show(configuredPanel, true);
  }

  function renderHomeAssistantFields() {
    const enabled = !!haEnabled.checked;
    show(haFields, enabled);
    if (!enabled) {
      haStatus.textContent = "Home Assistant is disabled for this instance.";
      haStatus.className = "status";
    }
  }

  function clearHomeAssistantErrors() {
    haUrl.classList.remove("error");
    haToken.classList.remove("error");
  }

  async function refreshHomeAssistantConfig() {
    try {
      const data = await getHomeAssistantConfig();
      haEnabled.checked = !!data.enabled;
      haUrl.value = data.url || "";
      haToken.value = "";
      show(haTokenNote, !!data.has_token);
      renderHomeAssistantFields();
      if (data.configured) {
        haStatus.textContent = "Home Assistant credentials are already configured.";
        haStatus.className = "status ok";
      } else if (data.enabled) {
        haStatus.textContent = "Enter a URL and token to finish enabling Home Assistant.";
        haStatus.className = "status warn";
      }
      return data;
    } catch (e) {
      haStatus.textContent = "Failed to load Home Assistant settings.";
      haStatus.className = "status error";
      return { enabled: false, configured: false, has_token: false, url: "" };
    }
  }

  haEnabled.addEventListener("change", () => {
    clearHomeAssistantErrors();
    renderHomeAssistantFields();
  });

  haUrl.addEventListener("input", clearHomeAssistantErrors);
  haToken.addEventListener("input", clearHomeAssistantErrors);

  haSave.addEventListener("click", async () => {
    const enabled = !!haEnabled.checked;
    const url = (haUrl.value || "").trim();
    const token = (haToken.value || "").trim();
    const hasSavedToken = !haTokenNote.classList.contains("hidden");

    clearHomeAssistantErrors();
    if (enabled) {
      if (!url) {
        haStatus.textContent = "Enter a Home Assistant MCP URL.";
        haStatus.className = "status warn";
        haUrl.classList.add("error");
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        haStatus.textContent = "Home Assistant MCP URL must start with http:// or https://.";
        haStatus.className = "status warn";
        haUrl.classList.add("error");
        return;
      }
      if (!token && !hasSavedToken) {
        haStatus.textContent = "Enter a Home Assistant token or keep an existing saved token.";
        haStatus.className = "status warn";
        haToken.classList.add("error");
        return;
      }
    }

    haStatus.textContent = enabled ? "Saving Home Assistant settings..." : "Disabling Home Assistant...";
    haStatus.className = "status";
    try {
      const res = await saveHomeAssistantConfig({ enabled, url, token });
      haEnabled.checked = !!res.enabled;
      haUrl.value = res.url || url;
      haToken.value = "";
      show(haTokenNote, !!res.has_token);
      renderHomeAssistantFields();
      haStatus.textContent = res.enabled
        ? "Home Assistant settings saved. Enable the home_assistant tool in a personality and restart to use it."
        : "Home Assistant disabled. Saved credentials were left intact.";
      haStatus.className = "status ok";
    } catch (e) {
      if (e.message === "missing_home_assistant_url") {
        haStatus.textContent = "Enter a Home Assistant MCP URL.";
        haUrl.classList.add("error");
      } else if (e.message === "missing_home_assistant_token") {
        haStatus.textContent = "Enter a Home Assistant token.";
        haToken.classList.add("error");
      } else {
        haStatus.textContent = "Failed to save Home Assistant settings.";
      }
      haStatus.className = "status error";
    }
  });

  // Handler for "Change API key" button
  changeKeyBtn.addEventListener("click", () => {
    show(configuredPanel, false);
    show(formPanel, true);
    input.value = "";
    statusEl.textContent = "";
    statusEl.className = "status";
  });

  // Remove error styling when user starts typing
  input.addEventListener("input", () => {
    input.classList.remove("error");
  });

  saveBtn.addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key) {
      statusEl.textContent = "Please enter a valid key.";
      statusEl.className = "status warn";
      input.classList.add("error");
      return;
    }
    statusEl.textContent = "Validating API key...";
    statusEl.className = "status";
    input.classList.remove("error");
    try {
      // First validate the key
      const validation = await validateKey(key);
      if (!validation.valid) {
        statusEl.textContent = "Invalid API key. Please check your key and try again.";
        statusEl.className = "status error";
        input.classList.add("error");
        return;
      }

      // If valid, save it
      statusEl.textContent = "Key valid! Saving...";
      statusEl.className = "status ok";
      await saveKey(key);
      statusEl.textContent = "Saved. Reloading…";
      statusEl.className = "status ok";
      window.location.reload();
    } catch (e) {
      input.classList.add("error");
      if (e.message === "invalid_api_key") {
        statusEl.textContent = "Invalid API key. Please check your key and try again.";
      } else {
        statusEl.textContent = "Failed to validate/save key. Please try again.";
      }
      statusEl.className = "status error";
    }
  });

  if (!st.has_key) {
    show(homeAssistantPanel, true);
    await refreshHomeAssistantConfig();
    statusEl.textContent = "";
    show(formPanel, true);
    show(loading, false);
    return;
  }

  show(homeAssistantPanel, true);
  await refreshHomeAssistantConfig();

  // Wait until backend routes are ready before rendering personalities UI
  const list = (await waitForPersonalityData()) || { choices: [] };
  statusEl.textContent = "";
  show(formPanel, false);
  if (!list.choices.length) {
    statusEl.textContent = "Personality endpoints not ready yet. Retry shortly.";
    statusEl.className = "status warn";
    show(loading, false);
    return;
  }

  // Initialize personalities UI
  try {
    const choices = Array.isArray(list.choices) ? list.choices : [];
    const DEFAULT_OPTION = choices[0] || "(built-in default)";
    const startupChoice = choices.includes(list.startup) ? list.startup : DEFAULT_OPTION;
    const currentChoice = choices.includes(list.current) ? list.current : startupChoice;

    function setStartupLabel(name) {
      const display = name && name !== DEFAULT_OPTION ? name : "Built-in default";
      pStartupLabel.textContent = `Launch on start: ${display}`;
    }

    // Populate select
    pSelect.innerHTML = "";
    for (const n of choices) {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      pSelect.appendChild(opt);
    }
    if (choices.length) {
      const preferred = choices.includes(startupChoice) ? startupChoice : currentChoice;
      pSelect.value = preferred;
    }
    const voices = await getVoices();
    pVoice.innerHTML = "";
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      pVoice.appendChild(opt);
    }
    setStartupLabel(startupChoice);

    function renderToolCheckboxes(available, enabled) {
      pAvail.innerHTML = "";
      const enabledSet = new Set(enabled);
      for (const t of available) {
        const wrap = document.createElement("div");
        wrap.className = "chk";
        const id = `tool-${t}`;
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = id;
        cb.value = t;
        cb.checked = enabledSet.has(t);
        const lab = document.createElement("label");
        lab.htmlFor = id;
        lab.textContent = t;
        wrap.appendChild(cb);
        wrap.appendChild(lab);
        pAvail.appendChild(wrap);
      }
    }

    function getSelectedTools() {
      const selected = new Set();
      pAvail.querySelectorAll('input[type="checkbox"]').forEach((el) => {
        if (el.checked) selected.add(el.value);
      });
      // Auto-include dependencies
      for (const [main, deps] of Object.entries(AUTO_WITH)) {
        if (selected.has(main)) {
          for (const d of deps) selected.add(d);
        }
      }
      return Array.from(selected);
    }

    function syncToolsTextarea() {
      const selected = getSelectedTools();
      const comments = pTools.value
        .split("\n")
        .filter((ln) => ln.trim().startsWith("#"));
      const body = selected.join("\n");
      pTools.value = (comments.join("\n") + (comments.length ? "\n" : "") + body).trim() + "\n";
    }

    function attachToolHandlers() {
      pAvail.addEventListener("change", (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
        const name = target.value;
        // If a main tool toggled, propagate to deps
        if (AUTO_WITH[name]) {
          for (const dep of AUTO_WITH[name]) {
            const depEl = pAvail.querySelector(`input[value="${dep}"]`);
            if (depEl) depEl.checked = target.checked || depEl.checked;
          }
        }
        syncToolsTextarea();
      });
    }

    async function loadSelected() {
      const selected = pSelect.value;
      const data = await loadPersonality(selected);
      pInstr.value = data.instructions || "";
      pTools.value = data.tools_text || "";
      pVoice.value = data.voice || "cedar";
      // Available tools as checkboxes
      renderToolCheckboxes(data.available_tools, data.enabled_tools);
      attachToolHandlers();
      // Default name field to last segment of selection
      const idx = selected.lastIndexOf("/");
      pName.value = idx >= 0 ? selected.slice(idx + 1) : "";
      pStatus.textContent = `Loaded ${selected}`;
      pStatus.className = "status";
    }

    pSelect.addEventListener("change", loadSelected);
    await loadSelected();
    show(personalityPanel, true);

    // pAvail change handler registered in attachToolHandlers()

    pApply.addEventListener("click", async () => {
      pStatus.textContent = "Applying...";
      pStatus.className = "status";
      try {
        const res = await applyPersonality(pSelect.value);
        if (res.startup) setStartupLabel(res.startup);
        pStatus.textContent = res.status || "Applied.";
        pStatus.className = "status ok";
      } catch (e) {
        pStatus.textContent = `Failed to apply${e.message ? ": " + e.message : ""}`;
        pStatus.className = "status error";
      }
    });

    pPersist.addEventListener("click", async () => {
      pStatus.textContent = "Saving for startup...";
      pStatus.className = "status";
      try {
        const res = await applyPersonality(pSelect.value, { persist: true });
        if (res.startup) setStartupLabel(res.startup);
        pStatus.textContent = res.status || "Saved for startup.";
        pStatus.className = "status ok";
      } catch (e) {
        pStatus.textContent = `Failed to persist${e.message ? ": " + e.message : ""}`;
        pStatus.className = "status error";
      }
    });

    pNew.addEventListener("click", () => {
      pName.value = "";
      pInstr.value = "# Write your instructions here\n# e.g., Keep responses concise and friendly.";
      pTools.value = "# tools enabled for this profile\n";
      // Keep available tools list, clear selection
      pAvail.querySelectorAll('input[type="checkbox"]').forEach((el) => {
        el.checked = false;
      });
      pVoice.value = "cedar";
      pStatus.textContent = "Fill fields and click Save.";
      pStatus.className = "status";
    });

    pSave.addEventListener("click", async () => {
      const name = (pName.value || "").trim();
      if (!name) {
        pStatus.textContent = "Enter a valid name.";
        pStatus.className = "status warn";
        return;
      }
      pStatus.textContent = "Saving...";
      pStatus.className = "status";
      try {
        // Ensure tools.txt reflects checkbox selection and auto-includes
        syncToolsTextarea();
        const res = await savePersonality({
          name,
          instructions: pInstr.value || "",
          tools_text: pTools.value || "",
          voice: pVoice.value || "cedar",
        });
        // Refresh select choices
        pSelect.innerHTML = "";
        for (const n of res.choices) {
          const opt = document.createElement("option");
          opt.value = n;
          opt.textContent = n;
          if (n === res.value) opt.selected = true;
          pSelect.appendChild(opt);
        }
        pStatus.textContent = "Saved.";
        pStatus.className = "status ok";
        // Auto-apply
        try { await applyPersonality(pSelect.value); } catch {}
      } catch (e) {
        pStatus.textContent = "Failed to save.";
        pStatus.className = "status error";
      }
    });
  } catch (e) {
    statusEl.textContent = "UI failed to load. Please refresh.";
    statusEl.className = "status warn";
  } finally {
    // Hide loading when initial setup is done (regardless of key presence)
    show(loading, false);
  }
}

window.addEventListener("DOMContentLoaded", init);
