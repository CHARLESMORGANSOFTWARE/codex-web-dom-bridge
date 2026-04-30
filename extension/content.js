(function codexDomBridge() {
  if (window.__codexDomBridgeLoaded) return;
  window.__codexDomBridgeLoaded = true;

  const bridgeUrl =
    window.CODEX_DOM_BRIDGE_URL ||
    document.documentElement?.dataset?.codexBridgeUrl ||
    "http://127.0.0.1:8797";

  const state = {
    clientId: sessionStorage.getItem("codexDomBridgeClientId") || crypto.randomUUID(),
    nextElementId: 1,
    elementIds: new WeakMap(),
    elementsById: new Map(),
    pendingFetches: 0,
    lastMutationAt: Date.now(),
    stopped: false
  };
  sessionStorage.setItem("codexDomBridgeClientId", state.clientId);

  const mutationObserver = new MutationObserver(() => {
    state.lastMutationAt = Date.now();
  });
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });

  function trackAsyncWork(promise) {
    state.pendingFetches += 1;
    return Promise.resolve(promise).finally(() => {
      state.pendingFetches = Math.max(0, state.pendingFetches - 1);
    });
  }

  function installNetworkTracking() {
    try {
      const originalFetch = window.fetch;
      if (typeof originalFetch === "function" && !originalFetch.__codexDomBridgeWrapped) {
        const wrappedFetch = function wrappedFetch(...args) {
          return trackAsyncWork(originalFetch.apply(this, args));
        };
        wrappedFetch.__codexDomBridgeWrapped = true;
        window.fetch = wrappedFetch;
      }
    } catch {
      // Some extension contexts do not allow replacing fetch. DOM quiet still works.
    }

    try {
      const originalSend = XMLHttpRequest.prototype.send;
      if (originalSend && !originalSend.__codexDomBridgeWrapped) {
        XMLHttpRequest.prototype.send = function wrappedSend(...args) {
          state.pendingFetches += 1;
          this.addEventListener(
            "loadend",
            () => {
              state.pendingFetches = Math.max(0, state.pendingFetches - 1);
            },
            { once: true }
          );
          return originalSend.apply(this, args);
        };
        XMLHttpRequest.prototype.send.__codexDomBridgeWrapped = true;
      }
    } catch {
      // XHR can be locked down in some page worlds.
    }
  }

  installNetworkTracking();

  function compactText(value, max = 180) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function absoluteUrl(value) {
    try {
      return new URL(value, location.href).href;
    } catch {
      return value || "";
    }
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/["\\#.:,[\]>+~*^$|=]/g, "\\$&");
  }

  function elementId(element) {
    if (state.elementIds.has(element)) return state.elementIds.get(element);
    const existing = element.getAttribute("data-codex-bridge-id");
    if (existing) {
      state.elementIds.set(element, existing);
      state.elementsById.set(existing, element);
      return existing;
    }
    const id = `e${state.nextElementId++}`;
    state.elementIds.set(element, id);
    state.elementsById.set(id, element);
    try {
      element.setAttribute("data-codex-bridge-id", id);
    } catch {
      // Some XML-ish nodes dislike attribute writes. WeakMap still carries us.
    }
    return id;
  }

  function selectorFor(element) {
    if (!(element instanceof Element)) return "";
    if (element.id) return `#${cssEscape(element.id)}`;
    if (element.getAttribute("data-codex-bridge-id")) {
      return `[data-codex-bridge-id="${element.getAttribute("data-codex-bridge-id")}"]`;
    }

    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.localName;
      if (!part) break;

      const name = current.getAttribute("name");
      const role = current.getAttribute("role");
      if (name) {
        part += `[name="${cssEscape(name)}"]`;
        parts.unshift(part);
        break;
      }
      if (role) part += `[role="${cssEscape(role)}"]`;

      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.localName === current.localName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }

      parts.unshift(part);
      current = parent;
      if (parts.length >= 5) break;
    }
    return parts.join(" > ");
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function boundsFor(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function textFromLabelledBy(element) {
    const ids = element.getAttribute("aria-labelledby");
    if (!ids) return "";
    return compactText(
      ids
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .join(" ")
    );
  }

  function labelFor(element) {
    if (!(element instanceof Element)) return "";

    const aria = element.getAttribute("aria-label");
    if (aria) return compactText(aria);

    const labelled = textFromLabelledBy(element);
    if (labelled) return labelled;

    if ("labels" in element && element.labels?.length) {
      return compactText([...element.labels].map((label) => label.textContent).join(" "));
    }

    const wrappingLabel = element.closest("label");
    if (wrappingLabel) return compactText(wrappingLabel.textContent);

    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return compactText(placeholder);

    const title = element.getAttribute("title");
    if (title) return compactText(title);

    const alt = element.getAttribute("alt");
    if (alt) return compactText(alt);

    const value = element.getAttribute("value");
    if (element.localName === "input" && value) return compactText(value);

    return compactText(element.textContent || element.getAttribute("name") || element.id || "");
  }

  function inferRole(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;

    const tag = element.localName;
    const type = (element.getAttribute("type") || "").toLowerCase();

    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "form") return "form";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "summary") return "button";

    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }

    if (element.tabIndex >= 0) return "generic-focusable";
    return "generic";
  }

  function kindFor(element, role = inferRole(element)) {
    const tag = element.localName;
    if (role === "link") return "links";
    if (["button", "checkbox", "radio"].includes(role)) return "buttons";
    if (["textbox", "combobox", "slider"].includes(role) || ["input", "textarea", "select"].includes(tag)) {
      return "inputs";
    }
    if (role === "heading") return "headings";
    if (role === "form") return "forms";
    return "other";
  }

  function valueFor(element) {
    if (!(element instanceof HTMLElement)) return undefined;
    if ("checked" in element && (element.type === "checkbox" || element.type === "radio")) {
      return Boolean(element.checked);
    }
    if ("value" in element && element.value !== "") return element.value;
    if (element.getAttribute("href")) return absoluteUrl(element.getAttribute("href"));
    return undefined;
  }

  function descriptorFor(element) {
    const role = inferRole(element);
    const id = elementId(element);
    const descriptor = {
      id,
      role,
      kind: kindFor(element, role),
      tag: element.localName,
      label: labelFor(element),
      selector: selectorFor(element),
      visible: isVisible(element),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      bounds: boundsFor(element)
    };

    const value = valueFor(element);
    if (value !== undefined) descriptor.value = value;
    if (role === "heading") descriptor.level = Number(element.localName.slice(1)) || undefined;
    return descriptor;
  }

  function candidateElements() {
    const selector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "form",
      "summary",
      "[role]",
      "[tabindex]",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "[contenteditable='']",
      "[contenteditable='true']"
    ].join(",");
    return [...document.querySelectorAll(selector)];
  }

  function observe(payload = {}) {
    const include = new Set(payload.include || ["links", "buttons", "inputs", "headings", "forms"]);
    const query = compactText(payload.query || "").toLowerCase();
    const limit = Math.min(Number(payload.limit || 200), 500);

    const elements = [];
    for (const element of candidateElements()) {
      const descriptor = descriptorFor(element);
      if (!include.has(descriptor.kind)) continue;
      if (!descriptor.visible && payload.visibleOnly !== false) continue;
      if (query) {
        const haystack = `${descriptor.role} ${descriptor.label} ${descriptor.selector} ${descriptor.value || ""}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      elements.push(descriptor);
      if (elements.length >= limit) break;
    }

    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY)
      },
      elements
    };
  }

  function findByRoleAndName(role, name) {
    const normalizedName = compactText(name).toLowerCase();
    return candidateElements().find((element) => {
      const descriptor = descriptorFor(element);
      return descriptor.role === role && descriptor.label.toLowerCase().includes(normalizedName);
    });
  }

  function resolveElement(payload = {}) {
    if (payload.id) {
      const mapped = state.elementsById.get(payload.id);
      if (mapped?.isConnected) return mapped;
      const byData = document.querySelector(`[data-codex-bridge-id="${cssEscape(payload.id)}"]`);
      if (byData) return byData;
    }
    if (payload.selector) {
      const bySelector = document.querySelector(payload.selector);
      if (bySelector) return bySelector;
    }
    if (payload.role && payload.name) {
      const byRole = findByRoleAndName(payload.role, payload.name);
      if (byRole) return byRole;
    }
    throw new Error(`element_not_found:${payload.id || payload.selector || payload.role || "unknown"}`);
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function setElementValue(element, value, append = false) {
    const stringValue = String(value ?? "");

    if (element instanceof HTMLSelectElement) {
      element.value = stringValue;
      dispatchInputEvents(element);
      return;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      if (append) {
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? element.value.length;
        setNativeValue(element, `${element.value.slice(0, start)}${stringValue}${element.value.slice(end)}`);
        const cursor = start + stringValue.length;
        element.setSelectionRange?.(cursor, cursor);
      } else {
        setNativeValue(element, stringValue);
      }
      dispatchInputEvents(element);
      return;
    }

    if (element.isContentEditable) {
      element.focus();
      if (append) {
        document.execCommand("insertText", false, stringValue);
      } else {
        element.textContent = stringValue;
        dispatchInputEvents(element);
      }
      return;
    }

    throw new Error("element_does_not_accept_text");
  }

  function keyEvent(element, type, key) {
    const event = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key
    });
    element.dispatchEvent(event);
    return event;
  }

  function act(payload = {}) {
    const element = resolveElement(payload);
    const action = payload.action;

    element.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
    if (action !== "click") element.focus?.({ preventScroll: true });

    if (action === "click") {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true }));
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, isPrimary: true }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      element.click();
    } else if (action === "type") {
      setElementValue(element, payload.value, payload.append === true);
    } else if (action === "setValue") {
      setElementValue(element, payload.value, false);
    } else if (action === "select") {
      setElementValue(element, payload.value, false);
    } else if (action === "check" || action === "uncheck") {
      if (!("checked" in element)) throw new Error("element_is_not_checkable");
      element.checked = action === "check";
      dispatchInputEvents(element);
    } else if (action === "focus") {
      element.focus();
    } else if (action === "press") {
      const key = String(payload.value || payload.key || "Enter");
      element.focus?.();
      keyEvent(element, "keydown", key);
      if (key === "Enter" && element instanceof HTMLInputElement && element.form) {
        element.form.requestSubmit?.();
      }
      keyEvent(element, "keyup", key);
    } else {
      throw new Error(`unsupported_action:${action}`);
    }

    return {
      action,
      element: descriptorFor(element),
      url: location.href,
      title: document.title
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(payload = {}) {
    const waitForKind = payload.for || payload.kind || "ready";
    const timeoutMs = Number(payload.timeoutMs || 10_000);
    const quietMs = Number(payload.quietMs || 500);
    const since = Number(payload.since || 0);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (waitForKind === "ready" && document.readyState === "complete") {
        return { matched: true, for: waitForKind, elapsedMs: Date.now() - startedAt };
      }

      if (waitForKind === "selector" && payload.value && document.querySelector(payload.value)) {
        return { matched: true, for: waitForKind, value: payload.value, elapsedMs: Date.now() - startedAt };
      }

      if (waitForKind === "text" && payload.value && document.body?.innerText?.includes(payload.value)) {
        return { matched: true, for: waitForKind, value: payload.value, elapsedMs: Date.now() - startedAt };
      }

      if (["networkIdle", "quiet", "domIdle"].includes(waitForKind)) {
        const quietEnough = Date.now() - state.lastMutationAt >= quietMs;
        const changedSinceMarker = !since || state.lastMutationAt >= since;
        const networkQuiet = state.pendingFetches === 0;
        if (document.readyState === "complete" && changedSinceMarker && quietEnough && networkQuiet) {
          return { matched: true, for: waitForKind, quietMs, elapsedMs: Date.now() - startedAt };
        }
      }

      await sleep(100);
    }

    return { matched: false, for: waitForKind, timeoutMs };
  }

  function textForRoot(selector, maxText = 6000) {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return "";
    return compactText(root.innerText || root.textContent || "", maxText);
  }

  async function waitForResultChange(selector, beforeText, payload = {}) {
    const timeoutMs = Number(payload.timeoutMs || 5_000);
    const quietMs = Number(payload.quietMs || 250);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const afterText = textForRoot(selector, payload.maxText || 6000);
      const changed = afterText !== beforeText;
      const quietEnough = Date.now() - state.lastMutationAt >= quietMs;
      const networkQuiet = state.pendingFetches === 0;
      if (changed && quietEnough && networkQuiet) {
        return {
          matched: true,
          for: "resultChange",
          quietMs,
          elapsedMs: Date.now() - startedAt
        };
      }
      await sleep(50);
    }

    return { matched: false, for: "resultChange", timeoutMs };
  }

  function extractFields(root, fields = {}) {
    const output = {};
    for (const [key, spec] of Object.entries(fields)) {
      const selector = typeof spec === "string" ? spec : spec.selector;
      const attr = typeof spec === "object" ? spec.attr : null;
      const node = selector ? root.querySelector(selector) : root;
      if (!node) {
        output[key] = null;
        continue;
      }
      const value = attr ? node.getAttribute(attr) : compactText(node.textContent, 2000);
      output[key] = attr === "href" ? absoluteUrl(value) : value;
    }
    return output;
  }

  function extract(payload = {}) {
    const root = payload.selector ? document.querySelector(payload.selector) : document.body;
    if (!root) throw new Error(`selector_not_found:${payload.selector}`);

    const result = {
      url: location.href,
      title: document.title,
      selector: payload.selector || "body"
    };

    if (payload.text !== false) result.text = compactText(root.innerText || root.textContent || "", payload.maxText || 8000);
    if (payload.html) result.html = root.innerHTML;
    if (payload.links) {
      result.links = [...root.querySelectorAll("a[href]")].slice(0, payload.limit || 100).map((link) => ({
        text: compactText(link.textContent),
        href: absoluteUrl(link.getAttribute("href"))
      }));
    }

    if (payload.fields) {
      result.fields = extractFields(root, payload.fields);
    }

    if (payload.items?.selector) {
      result.items = [...root.querySelectorAll(payload.items.selector)]
        .slice(0, payload.items.limit || 100)
        .map((item) => extractFields(item, payload.items.fields || { text: "" }));
    }

    return result;
  }

  function textInputScore(element) {
    if (!(element instanceof HTMLElement) || element.matches("[disabled],[aria-disabled='true']")) return -1;
    if (!isVisible(element)) return -1;

    const tag = element.localName;
    const type = (element.getAttribute("type") || "text").toLowerCase();
    const textTypes = new Set(["email", "number", "search", "tel", "text", "url"]);
    if (tag === "input" && !textTypes.has(type)) return -1;
    if (!["input", "textarea"].includes(tag) && !element.isContentEditable) return -1;

    const haystack = [
      type,
      element.id,
      element.getAttribute("name"),
      element.getAttribute("role"),
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      labelFor(element),
      element.closest("form")?.getAttribute("role"),
      element.closest("form")?.getAttribute("aria-label"),
      element.closest("form")?.getAttribute("action")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    let score = 10;
    if (type === "search" || element.getAttribute("role") === "searchbox") score += 50;
    if (/\b(search|query|find|q|keywords?)\b/.test(haystack)) score += 35;
    if (/\b(password|login|email|subscribe|newsletter)\b/.test(haystack)) score -= 30;
    if (element.value) score -= 5;
    return score;
  }

  function findSearchInput(payload = {}) {
    if (payload.id || payload.selector || payload.role || payload.name) {
      const element = resolveElement(payload);
      if (textInputScore(element) >= 0) return element;
      throw new Error("search_target_does_not_accept_text");
    }

    const candidates = [...document.querySelectorAll("input, textarea, [contenteditable=''], [contenteditable='true']")]
      .map((element) => ({ element, score: textInputScore(element) }))
      .filter((candidate) => candidate.score >= 0)
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) throw new Error("search_input_not_found");
    return candidates[0].element;
  }

  function clickElement(element) {
    element.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.click();
  }

  function submitSearch(input, payload = {}) {
    const submitter = payload.submitSelector ? document.querySelector(payload.submitSelector) : null;
    if (submitter) {
      clickElement(submitter);
      return { method: "click", submitter: descriptorFor(submitter) };
    }

    const form = input.form || input.closest("form");
    if (form?.requestSubmit) {
      form.requestSubmit();
      return { method: "requestSubmit", form: descriptorFor(form) };
    }

    if (form) {
      const event =
        typeof SubmitEvent === "function"
          ? new SubmitEvent("submit", { bubbles: true, cancelable: true })
          : new Event("submit", { bubbles: true, cancelable: true });
      const allowed = form.dispatchEvent(event);
      if (allowed && typeof form.submit === "function") form.submit();
      return { method: allowed ? "submit" : "submit-event-cancelled", form: descriptorFor(form) };
    }

    input.focus?.();
    keyEvent(input, "keydown", "Enter");
    keyEvent(input, "keyup", "Enter");
    return { method: "enter-key" };
  }

  async function search(payload = {}) {
    const query = String(payload.query ?? payload.value ?? "");
    if (!query) throw new Error("query_required");

    const startedAt = Date.now();
    const rootSelector = payload.resultsSelector || payload.selectorForResults || "body";
    const beforeText = textForRoot(rootSelector, payload.maxText || 6000);
    const input = findSearchInput(payload);
    setElementValue(input, query, false);

    const submit = payload.submit === false ? { method: "none" } : submitSearch(input, payload);
    const wait =
      payload.wait === false
        ? { matched: false, skipped: true }
        : payload.waitFor || payload.waitValue
          ? await waitFor({
              for: payload.waitFor || "quiet",
              quietMs: payload.quietMs || 250,
              timeoutMs: payload.timeoutMs || 5_000,
              value: payload.waitValue,
              since: startedAt
            })
          : await waitForResultChange(rootSelector, beforeText, payload);

    const root = document.querySelector(rootSelector);
    const hasArticleResults = Boolean(root?.querySelector("article"));
    const result = extract({
      selector: rootSelector,
      text: payload.text !== false,
      links: payload.links !== false,
      limit: payload.limit || 40,
      maxText: payload.maxText || 6000,
      items:
        payload.items ||
        (hasArticleResults
          ? {
              selector: "article",
              limit: payload.limit || 20,
              fields: {
                title: "h1,h2,h3,a",
                href: { selector: "a[href]", attr: "href" },
                text: ""
              }
            }
          : undefined)
    });

    return {
      query,
      input: descriptorFor(input),
      submit,
      wait,
      page: {
        url: location.href,
        title: document.title
      },
      result,
      elapsedMs: Date.now() - startedAt
    };
  }

  async function run(payload = {}) {
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    if (!steps.length) throw new Error("steps_required");

    const startedAt = Date.now();
    const outputs = [];
    let lastResult = null;
    const knownStepTypes = ["observe", "act", "wait", "extract", "search", "sleep"];

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index] || {};
      const inferredType = knownStepTypes.find((name) => Object.prototype.hasOwnProperty.call(step, name));
      const type = step.type || step.command || inferredType;
      const stepPayload = { ...(step.payload || (inferredType ? step[inferredType] : step)) };
      delete stepPayload.type;
      delete stepPayload.command;

      try {
        lastResult = await executeCommand(type, stepPayload);
        outputs.push({ ok: true, index, type, result: lastResult });
      } catch (error) {
        const failure = {
          ok: false,
          index,
          type,
          error: error instanceof Error ? error.message : String(error)
        };
        outputs.push(failure);
        if (step.continueOnError !== true && payload.continueOnError !== true) {
          return {
            ok: false,
            failedStep: failure,
            steps: outputs,
            elapsedMs: Date.now() - startedAt
          };
        }
      }
    }

    return {
      ok: true,
      steps: outputs,
      result: lastResult,
      page: {
        url: location.href,
        title: document.title
      },
      elapsedMs: Date.now() - startedAt
    };
  }

  async function executeCommand(type, payload = {}) {
    if (type === "observe") return observe(payload);
    if (type === "act") return act(payload);
    if (type === "wait") return waitFor(payload);
    if (type === "extract") return extract(payload);
    if (type === "search") return search(payload);
    if (type === "run") return run(payload);
    if (type === "sleep") {
      const ms = Math.min(Number(payload.ms || payload.timeoutMs || 250), 30_000);
      await sleep(ms);
      return { sleptMs: ms };
    }
    throw new Error(`unknown_command:${type}`);
  }

  function metadata() {
    return {
      url: location.href,
      title: document.title,
      visibility: document.visibilityState,
      readyState: document.readyState,
      userAgent: navigator.userAgent
    };
  }

  async function postJson(path, payload) {
    const response = await fetch(`${bridgeUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: false
    });
    return response.json();
  }

  async function hello() {
    await postJson("/client/hello", {
      clientId: state.clientId,
      metadata: metadata()
    });
  }

  async function poll() {
    while (!state.stopped) {
      try {
        await hello();
        const response = await fetch(
          `${bridgeUrl}/client/${encodeURIComponent(state.clientId)}/command?timeoutMs=25000`,
          { headers: { accept: "application/json" } }
        );
        const payload = await response.json();
        if (!payload.command) continue;
        await handleCommand(payload.command);
      } catch (error) {
        await sleep(1000);
      }
    }
  }

  async function handleCommand(command) {
    let result;
    try {
      result = await executeCommand(command.type, command.payload);
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    await postJson(`/client/${encodeURIComponent(state.clientId)}/result`, {
      commandId: command.id,
      result,
      metadata: metadata()
    });
  }

  window.codexDomBridge = {
    observe,
    act,
    wait: waitFor,
    extract,
    search,
    run,
    metadata,
    clientId: state.clientId,
    stop() {
      state.stopped = true;
      mutationObserver.disconnect();
    }
  };

  poll();
})();
