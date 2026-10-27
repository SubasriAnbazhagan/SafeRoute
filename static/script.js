
const startButton = document.getElementById("startButton");
const cancelButton = document.getElementById("cancelButton");
const statusText = document.getElementById("status");
const countdownText = document.getElementById("countdown");
const historyList = document.getElementById("historyList");

let activeAlertId = null;
let timer = null;
let secondsLeft = 10;
let busy = false;
let locationData = { latitude: null, longitude: null };

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showStatus(message) {
  statusText.textContent = message;
}

async function startAlert() {
  if (busy || activeAlertId !== null) return;

  busy = true;
  startButton.disabled = true;
  secondsLeft = 10;
  countdownText.textContent = secondsLeft;
  cancelButton.hidden = false;
  showStatus("Preparing simulated accident alert...");

  try {
    const alert = await api("/api/alerts", {
      method: "POST",
      body: JSON.stringify({
        event_type: "accident",
        source: "website",
        ...locationData
      })
    });

    activeAlertId = alert.id;
    showStatus("Demo alert saved. Cancel within 10 seconds.");
    await refreshHistory();

    timer = setInterval(async () => {
      secondsLeft--;
      countdownText.textContent = secondsLeft;

      if (secondsLeft <= 0) {
        clearInterval(timer);
        timer = null;
        activeAlertId = null;
        countdownText.textContent = "";
        cancelButton.hidden = true;
        startButton.disabled = false;
        showStatus(
          "Demo countdown completed. No emergency service was contacted."
        );
      }
    }, 1000);
  } catch (error) {
    countdownText.textContent = "";
    cancelButton.hidden = true;
    startButton.disabled = false;
    showStatus("Could not save alert: " + error.message);
  } finally {
    busy = false;
  }
}

async function cancelAlert() {
  if (activeAlertId === null) return;

  clearInterval(timer);
  timer = null;

  try {
    await api(`/api/alerts/${activeAlertId}/cancel`, {
      method: "POST",
      body: JSON.stringify({})
    });

    activeAlertId = null;
    countdownText.textContent = "";
    cancelButton.hidden = true;
    startButton.disabled = false;
    showStatus("Demo alert cancelled.");
    await refreshHistory();
  } catch (error) {
    showStatus("Could not cancel alert: " + error.message);
  }
}

async function refreshHistory() {
  try {
    const alerts = await api("/api/alerts");
    historyList.replaceChildren();

    if (alerts.length === 0) {
      historyList.textContent = "No alerts recorded yet.";
      return;
    }

    for (const alert of alerts) {
      const item = document.createElement("div");
      item.className = "event";

      const heading = document.createElement("strong");
      heading.textContent =
        `#${alert.id} · ${alert.event_type} · ${alert.status}`;

      const details = document.createElement("small");
      details.textContent =
        `Source: ${alert.source} · ${new Date(alert.created_at).toLocaleString()}`;

      item.append(heading, document.createElement("br"), details);
      historyList.append(item);
    }
  } catch (error) {
    historyList.textContent = "Unable to load history: " + error.message;
  }
}

startButton.addEventListener("click", startAlert);
cancelButton.addEventListener("click", cancelAlert);
document.getElementById("refreshButton").addEventListener("click", refreshHistory);

document.getElementById("locationButton").addEventListener("click", () => {
  if (!navigator.geolocation) {
    document.getElementById("locationStatus").textContent =
      "Browser GPS unsupported";
    return;
  }

  navigator.geolocation.getCurrentPosition(
    position => {
      locationData = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      };
      document.getElementById("locationStatus").textContent =
        `${locationData.latitude.toFixed(4)}, ${locationData.longitude.toFixed(4)}`;
    },
    () => {
      document.getElementById("locationStatus").textContent =
        "Permission denied or unavailable";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

api("/api/health")
  .then(() => {
    document.getElementById("hardwareStatus").textContent =
      "Backend online · ESP32 not connected";
  })
  .catch(() => {
    document.getElementById("hardwareStatus").textContent =
      "Backend unavailable";
  });

refreshHistory();
async function loadContacts() {
    const contactList = document.getElementById("contactList");

    if (!contactList) {
        console.error("Contact list element not found in HTML.");
        return;
    }

    try {
        const response = await fetch("/api/contacts");
        const contacts = await response.json();

        if (!response.ok) {
            throw new Error("Failed to load contacts");
        }

        contactList.replaceChildren();

        contacts.forEach((contact) => {
            const item = document.createElement("div");
            const name = document.createElement("strong");
            const phone = document.createElement("p");

            name.textContent = contact.name;
            phone.textContent = contact.phone;

            item.append(name, phone);
            contactList.appendChild(item);
        });
    } catch (error) {
        console.error("Error loading contacts:", error);
    }
}

document.addEventListener("DOMContentLoaded", loadContacts);
