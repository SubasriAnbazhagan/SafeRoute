// SafeRoute frontend — all data is persisted through the Flask API (SQLite).
const $ = id => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

const SAMPLE = { latitude: 11.4, longitude: 77.73 };
const OPEN_STATUSES = new Set(["active", "pending", "retry_queued", "send_failed"]);
const TYPE_META = {
    accident:   { label: "Accident",   icon: "car" },
    manual_sos: { label: "Manual SOS", icon: "sos" },
    health_sos: { label: "Health SOS", icon: "heart" },
    demo:       { label: "Demo",       icon: "overview" }
};
const STATUS_LABEL = {
    pending: "Pending", retry_queued: "Retrying", send_failed: "Send failed",
    failed: "Failed", cancelled: "Cancelled", acknowledged: "Acknowledged",
    resolved: "Resolved", logged: "Logged", completed: "Completed", active: "Active"
};
const PAGES = {
    home:         ["Overview", "Current status, recent alerts and setup at a glance."],
    history:      ["Alert history", "Every alert recorded in the SafeRoute database."],
    manualSos:    ["Manual SOS", "Raise an alert yourself."],
    accidentPage: ["Accident test", "Rehearse the crash-detection flow without sending anything."],
    health:       ["Health check", "Test the heart-rate alert threshold."],
    contacts:     ["Contacts", "People and services notified when an alert goes out."],
    gps:          ["Location", "The coordinates attached to new alerts."],
    settings:     ["Settings", "Countdown, retry rounds and hardware status."]
};

let settings = {
    seconds: 15, police: "", rounds: 0, interval: 30,
    policy: "failed_or_unacked", cancelPolicy: "immediate"
};
let geo = { ...SAMPLE, live: false, accuracy: null };
let contactsCache = [];
let editingContactId = null;
let historyFilter = "";
let lastSummary = null;

// accident cycle state
let countdownTimer = null;
let repeatTimer = null;
let countdownLeft = 0;
let alertPending = false;
let sendFailed = false;
let activeAlertId = null;

// ---------- helpers ----------
async function api(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const err = new Error(data.error || `Request failed (${response.status})`);
        err.status = response.status;
        throw err;
    }
    return data;
}

function toast(message, kind = "info", ms = 3200) {
    const node = el("div", "toast " + kind, message);
    $("toasts").append(node);
    setTimeout(() => node.remove(), ms);
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ico");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#i-" + name);
    svg.append(use);
    return svg;
}

function setIcon(svg, name) {
    svg.querySelector("use").setAttribute("href", "#i-" + name);
}

function formatTime(sqliteTime) {
    // SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS"
    const date = new Date(String(sqliteTime).replace(" ", "T") + "Z");
    if (isNaN(date)) return sqliteTime;
    const diff = (Date.now() - date) / 1000;
    if (diff < 60) return "Just now";
    if (diff < 3600) return Math.floor(diff / 60) + " min ago";
    if (diff < 86400) return Math.floor(diff / 3600) + " h ago";
    return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function locationText() {
    return `${geo.latitude.toFixed(4)}, ${geo.longitude.toFixed(4)}`;
}

function badge(statusValue) {
    return el("span", "badge s-" + statusValue, STATUS_LABEL[statusValue] || statusValue);
}

// ---------- navigation ----------
function showView(id) {
    document.querySelectorAll(".nav-item").forEach(b =>
        b.classList.toggle("active", b.dataset.view === id));
    document.querySelectorAll(".view").forEach(s =>
        s.classList.toggle("active", s.id === id));
    const [title, desc] = PAGES[id] || ["SafeRoute", ""];
    $("pageTitle").textContent = title;
    $("pageDesc").textContent = desc;
    document.title = title + " · SafeRoute";
    window.scrollTo({ top: 0 });
    document.querySelector(".nav-item.active")
        ?.scrollIntoView({ inline: "center", block: "nearest" });
    if (id === "history") drawHistory();
}

document.querySelectorAll(".nav-item").forEach(b =>
    b.addEventListener("click", () => showView(b.dataset.view)));
document.querySelectorAll("[data-goto]").forEach(b =>
    b.addEventListener("click", () => showView(b.dataset.goto)));

// ---------- status (plate + header chip) ----------
function status(title, detail, isAlert = false) {
    $("status").textContent = title;
    $("detail").textContent = detail;
    $("hero").classList.toggle("alerting", isAlert);
    setIcon($("hero").querySelector(".plate-icon .ico"), isAlert ? "sos" : "shield");
    $("headerStatus").textContent = isAlert ? "Alert active" : "All clear";
    $("headerDot").classList.toggle("alert", isAlert);
    $("statusChip").classList.toggle("alert", isAlert);
}

// ---------- overview summary ----------
function setReady(id, done, text) {
    const li = $(id);
    li.classList.toggle("done", done);
    setIcon(li.querySelector(".ico"), done ? "check" : "dash");
    li.querySelector("span").textContent = text;
}

function drawReadiness() {
    if (!lastSummary) return;
    const n = lastSummary.contacts;
    setReady("readyContacts", n > 0, n ? `${n} emergency contact${n > 1 ? "s" : ""}` : "No emergency contacts yet");
    setReady("readyPolice", lastSummary.police_configured,
        lastSummary.police_configured ? `Police number ${settings.police || "saved"}` : "No police number");
    setReady("readyLocation", geo.live, geo.live ? "Live location shared" : "Using sample location");
}

async function refreshSummary() {
    let s;
    try { s = await api("/api/summary"); }
    catch (error) { toast("Can't reach the server: " + error.message, "error"); return; }
    lastSummary = s;

    $("contactCount").textContent = s.contacts;
    $("openCount").textContent = s.open_alerts.length;
    $("eventCount").textContent = s.alerts_total;
    $("locationMode").textContent = geo.live ? "Live" : "Sample";

    const open = s.open_alerts.length;
    $("openBadge").textContent = open;
    $("openBadge").classList.toggle("hidden", open === 0);
    $("resolveAll").classList.toggle("hidden", open === 0);

    if (!countdownTimer && !alertPending) {
        if (open) {
            const types = [...new Set(s.open_alerts.map(a => TYPE_META[a.alert_type]?.label || a.alert_type))];
            status(`${open} open alert${open > 1 ? "s" : ""}`,
                `${types.join(", ")}. Resolve once the rider is confirmed safe.`, true);
        } else {
            status("All clear", "No open alerts. Hardware is not connected.");
        }
    }

    drawReadiness();
    const missing = [];
    if (!s.contacts) missing.push("add a contact");
    if (!s.police_configured) missing.push("save a police number");
    $("setupHint").textContent = missing.length
        ? `To finish setup, ${missing.join(" and ")}.` : "";

    const list = $("recentList");
    list.replaceChildren();
    if (!s.recent.length) list.append(el("div", "empty", "No alerts yet. Activity appears here as it happens."));
    s.recent.forEach(a => list.append(alertRow(a, false)));
}

// ---------- alerts / history ----------
function alertRow(alert, withActions = true) {
    const meta = TYPE_META[alert.alert_type] || { label: alert.alert_type, icon: "overview" };
    const isOpen = OPEN_STATUSES.has(alert.status);
    const row = el("div", "row");

    const ic = el("div", "row-icon" + (isOpen ? " open" : ""));
    ic.append(icon(meta.icon));
    row.append(ic);

    const body = el("div", "row-body");
    const title = el("div", "row-title");
    title.append(el("span", "", meta.label), badge(alert.status));
    body.append(title);
    body.append(el("div", "row-sub",
        alert.message + (alert.attempt_count ? `, ${alert.attempt_count} round${alert.attempt_count > 1 ? "s" : ""}` : "")));

    const metaRow = el("div", "row-meta");
    metaRow.append(el("span", "", formatTime(alert.created_at)));
    if (alert.location) metaRow.append(el("span", "", alert.location));
    metaRow.append(el("span", "", "#" + alert.id));
    body.append(metaRow);
    row.append(body);

    if (withActions && isOpen && alert.id !== activeAlertId) {
        const actions = el("div", "row-actions");
        const resolve = el("button", "btn btn-secondary btn-sm", "Resolve");
        resolve.onclick = async () => {
            try {
                await api(`/api/alerts/${alert.id}/status`, {
                    method: "POST", body: JSON.stringify({ status: "resolved" })
                });
                toast(`Alert #${alert.id} resolved.`, "success");
                await refreshAll();
            } catch (error) { toast(error.message, "error"); }
        };
        actions.append(resolve);
        row.append(actions);
    }
    return row;
}

async function drawHistory() {
    const list = $("historyList");
    let alerts;
    try {
        const type = historyFilter && historyFilter !== "open" ? `?type=${historyFilter}` : "";
        alerts = await api("/api/alerts" + type);
    } catch (error) {
        list.replaceChildren(el("div", "empty", "History couldn't load: " + error.message));
        return;
    }
    if (historyFilter === "open") alerts = alerts.filter(a => OPEN_STATUSES.has(a.status));

    list.replaceChildren();
    if (!alerts.length) {
        list.append(el("div", "empty", historyFilter ? "Nothing matches this filter." : "No alerts recorded yet."));
        return;
    }
    alerts.forEach(a => list.append(alertRow(a)));
}

$("filters").addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    historyFilter = chip.dataset.filter;
    document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
    drawHistory();
});

async function createAlert(alertType, message, statusValue) {
    const alert = await api("/api/alerts", {
        method: "POST",
        body: JSON.stringify({
            alert_type: alertType, message, location: locationText(),
            ...(statusValue ? { status: statusValue } : {})
        })
    });
    await refreshAll();
    return alert;
}

$("resolveAll").onclick = async () => {
    if (alertPending || countdownTimer) await stopAlert("cancel", true);
    try {
        const r = await api("/api/alerts/resolve-all", { method: "POST", body: "{}" });
        toast(`${r.resolved} alert${r.resolved === 1 ? "" : "s"} resolved.`, "success");
    } catch (error) { toast(error.message, "error"); }
    await refreshAll();
};

$("clear").onclick = async () => {
    if (!confirm("Delete all alert history? This can't be undone.")) return;
    try {
        await api("/api/alerts", { method: "DELETE" });
        toast("History cleared.");
        await refreshAll();
    } catch (error) { toast(error.message, "error"); }
};

// ---------- contacts ----------
async function drawContacts() {
    const list = $("contactsList");
    try { contactsCache = await api("/api/contacts"); }
    catch (error) {
        list.replaceChildren(el("div", "empty", "Contacts couldn't load: " + error.message));
        return;
    }

    $("contactPill").textContent = contactsCache.length;
    list.replaceChildren();
    if (!contactsCache.length) {
        list.append(el("div", "empty", "No contacts yet. Add someone who should hear about an alert."));
        return;
    }

    contactsCache.forEach(contact => {
        const row = el("div", "row");
        row.append(el("div", "avatar", contact.name.trim().charAt(0).toUpperCase()));

        const body = el("div", "row-body");
        const title = el("div", "row-title");
        title.append(el("span", "", contact.name));
        if (contact.relationship) title.append(el("span", "badge", contact.relationship));
        body.append(title, el("div", "row-sub", contact.phone));
        row.append(body);

        const actions = el("div", "row-actions");
        const edit = el("button", "btn btn-ghost btn-sm", "Edit");
        edit.onclick = () => startEdit(contact);
        const remove = el("button", "btn btn-ghost btn-sm", "Remove");
        remove.onclick = async () => {
            if (!confirm(`Remove ${contact.name} from emergency contacts?`)) return;
            try {
                await api(`/api/contacts/${contact.id}`, { method: "DELETE" });
                toast(`${contact.name} removed.`);
                if (editingContactId === contact.id) resetForm();
                await refreshAll();
            } catch (error) { toast(error.message, "error"); }
        };
        actions.append(edit, remove);
        row.append(actions);
        list.append(row);
    });
}

function startEdit(contact) {
    editingContactId = contact.id;
    $("name").value = contact.name;
    $("number").value = contact.phone;
    $("relationship").value = contact.relationship || "";
    $("contactFormTitle").textContent = "Edit contact";
    $("formSubmit").textContent = "Save contact";
    $("formCancel").classList.remove("hidden");
    $("formError").textContent = "";
    $("name").focus();
}

function resetForm() {
    editingContactId = null;
    $("form").reset();
    $("contactFormTitle").textContent = "Add contact";
    $("formSubmit").textContent = "Add contact";
    $("formCancel").classList.add("hidden");
    $("formError").textContent = "";
    ["name", "number"].forEach(id => $(id).removeAttribute("aria-invalid"));
}
$("formCancel").onclick = resetForm;

function validPhone(phone) {
    const digits = phone.replace(/\D/g, "");
    return /^\+?[0-9\s\-()]{7,20}$/.test(phone) && digits.length >= 7 && digits.length <= 15;
}

$("form").onsubmit = async event => {
    event.preventDefault();
    const name = $("name").value.trim();
    const phone = $("number").value.trim();

    ["name", "number"].forEach(id => $(id).removeAttribute("aria-invalid"));
    if (!name) {
        $("name").setAttribute("aria-invalid", "true");
        $("formError").textContent = "Enter the contact's name.";
        return;
    }
    if (!validPhone(phone)) {
        $("number").setAttribute("aria-invalid", "true");
        $("formError").textContent = "Enter a phone number with 7 to 15 digits. A leading + is fine.";
        return;
    }

    const payload = JSON.stringify({ name, phone, relationship: $("relationship").value });
    $("formSubmit").disabled = true;
    try {
        if (editingContactId) {
            await api(`/api/contacts/${editingContactId}`, { method: "PUT", body: payload });
            toast("Contact saved.", "success");
        } else {
            await api("/api/contacts", { method: "POST", body: payload });
            toast(`${name} added.`, "success");
        }
        resetForm();
        await refreshAll();
    } catch (error) {
        $("formError").textContent = error.message;
        if (error.status === 409) $("number").setAttribute("aria-invalid", "true");
    } finally {
        $("formSubmit").disabled = false;
    }
};

// ---------- settings ----------
async function saveSettings(partial) {
    settings = await api("/api/settings", { method: "PUT", body: JSON.stringify(partial) });
    return settings;
}

$("savePolice").onclick = async () => {
    const value = $("police").value.trim();
    try {
        await saveSettings({ police: value });
        toast(value ? "Police number saved." : "Police number removed.", "success");
        await refreshSummary();
    } catch (error) { toast(error.message, "error"); }
};

$("saveSettings").onclick = async () => {
    try {
        await saveSettings({
            seconds: Number($("seconds").value),
            rounds: Number($("rounds").value),
            interval: Number($("interval").value),
            policy: $("policy").value,
            cancelPolicy: $("cancelPolicy").value
        });
        toast("Settings saved.", "success");
    } catch (error) { toast(error.message, "error"); }
};

async function loadSettings() {
    try { settings = await api("/api/settings"); }
    catch (error) { toast("Settings couldn't load: " + error.message, "error"); }
    $("seconds").value = String(settings.seconds || 15);
    $("rounds").value = String(settings.rounds ?? 0);
    $("interval").value = String(settings.interval || 30);
    $("policy").value = settings.policy || "failed_or_unacked";
    $("cancelPolicy").value = settings.cancelPolicy || "immediate";
    $("police").value = settings.police || "";
    drawReadiness();
}

// ---------- location ----------
function drawLocation() {
    $("coords").textContent = locationText();
    $("gpsNote").textContent = geo.live
        ? "New alerts include your browser location. GPS hardware is not connected."
        : "Alerts use sample coordinates until you share your browser location.";
    $("gpsAccuracy").textContent = geo.live && geo.accuracy
        ? `Accurate to about ${Math.round(geo.accuracy)} m` : "Sample point near Erode, Tamil Nadu";
    $("locationMode").textContent = geo.live ? "Live" : "Sample";
    drawReadiness();
}

$("useLocation").onclick = () => {
    if (!navigator.geolocation) { toast("This browser can't share location.", "error"); return; }
    $("useLocation").disabled = true;
    navigator.geolocation.getCurrentPosition(
        pos => {
            geo = { latitude: pos.coords.latitude, longitude: pos.coords.longitude,
                    accuracy: pos.coords.accuracy, live: true };
            $("useLocation").disabled = false;
            drawLocation();
            toast("Live location is now attached to new alerts.", "success");
        },
        () => {
            $("useLocation").disabled = false;
            toast("Location access was blocked. Allow it in the browser and try again.", "error");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
};
$("useSample").onclick = () => { geo = { ...SAMPLE, live: false, accuracy: null }; drawLocation(); };
$("map").onclick = () => window.open(
    `https://maps.google.com/?q=${geo.latitude},${geo.longitude}`, "_blank", "noopener");

// ---------- accident alert cycle ----------
function clearTimers() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (repeatTimer) { clearTimeout(repeatTimer); repeatTimer = null; }
}

function setCycleButtons({ cancel = false, ack = false, fail = false, close = false }) {
    $("cancel").classList.toggle("hidden", !cancel);
    $("ack").disabled = !ack;
    $("fail").disabled = !fail;
    $("ack").parentElement.classList.toggle("hidden", !(ack || fail));
    $("closeCycle").classList.toggle("hidden", !close);
}

function endCycle() {
    clearTimers();
    alertPending = false;
    activeAlertId = null;
    $("accident").disabled = false;
}

async function stopAlert(reason, quiet = false) {
    const id = activeAlertId;
    endCycle();
    $("countbox").classList.add("hidden");

    try {
        if (id !== null) {
            if (reason === "ack") {
                await api(`/api/alerts/${id}/status`, {
                    method: "POST", body: JSON.stringify({ status: "acknowledged" })
                });
            } else {
                await api(`/api/alerts/${id}/cancel`, { method: "POST", body: "{}" });
            }
        }
    } catch (error) { console.warn(error); }

    if (!quiet) toast(reason === "ack"
        ? "Alert acknowledged. Retries stopped."
        : "Alert cancelled. No messages were sent.", "success");
    await refreshAll();
}

async function attemptRound() {
    if (!alertPending || activeAlertId === null) return;

    sendFailed = false;
    let result;
    try {
        result = await api(`/api/alerts/${activeAlertId}/retry`, { method: "POST", body: "{}" });
    } catch (error) {
        // Round limit reached (or alert closed elsewhere): end the cycle cleanly.
        endCycle();
        $("phaseLabel").textContent = "Alert rounds finished";
        $("count").textContent = "—";
        $("progressBar").style.width = "0%";
        $("cycleInfo").textContent = "The round limit was reached without an acknowledgement.";
        $("attemptStatus").textContent = "The alert is marked as failed in history.";
        setCycleButtons({ close: true });
        toast("Round limit reached. Alert marked as failed.", "error");
        await refreshAll();
        return;
    }

    $("phaseLabel").textContent = result.max_retries
        ? `Alert round ${result.attempts} of ${result.max_retries}` : `Alert round ${result.attempts}`;
    $("count").textContent = settings.interval + "s";
    $("progressBar").style.width = "100%";
    $("cycleInfo").textContent =
        `Next round in ${settings.interval} seconds unless someone acknowledges or you cancel.`;
    $("attemptStatus").textContent = "Simulated send, waiting for acknowledgement.";
    await refreshAll();

    repeatTimer = setTimeout(() => {
        if (!alertPending) return;
        $("attemptStatus").textContent = sendFailed
            ? "The last send failed. Retrying now."
            : "No acknowledgement. Retrying now.";
        attemptRound();
    }, Math.max(10, Number(settings.interval) || 30) * 1000);
}

async function start() {
    if (countdownTimer || alertPending || activeAlertId !== null) {
        toast("An alert is already running. Cancel or acknowledge it first.", "error");
        return;
    }
    $("accident").disabled = true;

    try {
        const alert = await api("/api/alerts", {
            method: "POST",
            body: JSON.stringify({ alert_type: "accident", location: locationText(),
                                   message: "Simulated crash detected" })
        });
        activeAlertId = alert.id;
    } catch (error) {
        $("accident").disabled = false;
        toast("The alert couldn't be saved: " + error.message, "error");
        return;
    }

    const total = Number(settings.seconds) || 15;
    countdownLeft = total;
    alertPending = false;

    $("countbox").classList.remove("hidden");
    $("phaseLabel").textContent = "Cancel countdown";
    $("count").textContent = countdownLeft;
    $("progressBar").style.width = "100%";
    $("cycleInfo").textContent = "Alerts start when the countdown ends.";
    $("attemptStatus").textContent = "If this is a false alarm, stop it now.";
    setCycleButtons({ cancel: true });

    countdownTimer = setInterval(() => {
        countdownLeft--;
        $("count").textContent = Math.max(countdownLeft, 0);
        $("progressBar").style.width = (Math.max(countdownLeft, 0) / total * 100) + "%";
        if (countdownLeft <= 0) {
            clearInterval(countdownTimer);
            countdownTimer = null;
            alertPending = true;
            setCycleButtons({ cancel: true, ack: true, fail: true });
            status("Alerting contacts", "Simulated alert rounds are running. No SMS is sent.", true);
            attemptRound();
        }
    }, 1000);

    status("Crash detected", "Countdown running. Cancel if this is a false alarm.", true);
    await refreshAll();
}

$("accident").onclick = start;
$("cancel").onclick = () => stopAlert("cancel");
$("ack").onclick = () => { if (alertPending) stopAlert("ack"); };
$("closeCycle").onclick = () => { $("countbox").classList.add("hidden"); refreshSummary(); };

$("fail").onclick = async () => {
    if (!alertPending || activeAlertId === null) return;
    sendFailed = true;
    $("attemptStatus").textContent =
        `Simulated send failure. Retrying in ${settings.interval} seconds.`;
    try {
        await api(`/api/alerts/${activeAlertId}/status`, {
            method: "POST", body: JSON.stringify({ status: "send_failed" })
        });
        await refreshAll();
    } catch (error) { console.warn(error); }
};

// ---------- manual SOS ----------
$("sos").onclick = async () => {
    if (alertPending || countdownTimer) {
        toast("An accident alert is already running. Stop or acknowledge it first.", "error");
        return;
    }
    $("sos").disabled = true;
    try {
        await createAlert("manual_sos", "SOS raised by rider");
        $("sosResult").textContent = "SOS recorded. Simulation only, no SMS was sent.";
        const n = contactsCache.length;
        $("sosRecipients").textContent = n
            ? `With SMS enabled, this would reach ${n} contact${n > 1 ? "s" : ""}${settings.police ? " and the police number" : ""}.`
            : "No contacts are saved yet, so nobody would be notified. Add them under Contacts.";
        toast("SOS recorded. Resolve it from Overview once the rider is safe.");
    } catch (error) {
        $("sosResult").textContent = "The SOS couldn't be saved: " + error.message;
    } finally {
        setTimeout(() => { $("sos").disabled = false; }, 1500);
    }
};

// ---------- health check ----------
$("checkHealth").onclick = async () => {
    const bpm = Number($("heartRate").value);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 250) {
        $("healthResult").textContent = "Enter a value from 20 to 250 BPM.";
        return;
    }

    const triggered = bpm < 50 || bpm > 120;
    $("gauge").classList.remove("hidden");
    $("gaugeValue").textContent = bpm;
    $("gaugeValue").className = triggered ? "health-bad" : "health-ok";
    $("healthResult").textContent = triggered
        ? "Outside 50–120 BPM. A Health SOS was raised."
        : "Within 50–120 BPM. Logged, no alert raised.";

    try {
        await createAlert("health_sos",
            triggered ? `Heart rate ${bpm} BPM, outside safe range` : `Heart rate ${bpm} BPM, normal`,
            triggered ? undefined : "logged");
        if (triggered) toast("Health SOS raised.", "error");
    } catch (error) { $("healthResult").textContent += ` The reading couldn't be saved: ${error.message}`; }
};

// ---------- theme ----------
function applyTheme(theme, save) {
    document.documentElement.dataset.theme = theme;
    const next = theme === "dark" ? "light" : "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(btn => {
        setIcon(btn.querySelector(".ico"), next === "light" ? "sun" : "moon");
        btn.setAttribute("aria-label", `Switch to ${next} mode`);
        btn.title = `Switch to ${next} mode`;
        const label = btn.querySelector(".theme-label");
        if (label) label.textContent = next === "light" ? "Light mode" : "Dark mode";
    });
    document.querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", theme === "dark" ? "#12161b" : "#ffffff");
    if (save) { try { localStorage.setItem("saferoute-theme", theme); } catch (e) {} }
}

document.querySelectorAll("[data-theme-toggle]").forEach(btn => btn.addEventListener("click", () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true)));

// follow the OS theme until the user picks one
matchMedia("(prefers-color-scheme: light)").addEventListener("change", e => {
    let saved = null;
    try { saved = localStorage.getItem("saferoute-theme"); } catch (err) {}
    if (!saved) applyTheme(e.matches ? "light" : "dark", false);
});

applyTheme(document.documentElement.dataset.theme || "dark", false);

// ---------- init ----------
async function refreshAll() {
    await Promise.all([refreshSummary(), drawContacts(), drawHistory()]);
}

drawLocation();
loadSettings();
refreshAll();
setInterval(refreshSummary, 30000); // keep relative times + open alerts fresh
