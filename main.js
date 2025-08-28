// ==UserScript==
// @name         Auto-Airport Flight Logger (GeoFS)
// @namespace    https://your-va.org/flightlogger
// @version      2025-08-16
// @description  Logs flights with crash detection, auto ICAO detection, session recovery & terrain-based AGL check
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const WEBHOOK_URL = "https://discord.com/api/webhooks/1406257491200966676/uo2BElGKf3Z2OTy2KGskd-cuIzKdiJSlgkiYUd9Hd0_622E0xE88Xigmqp4we6Woepxl";
  const STORAGE_KEY = "geofs_flight_logger_session";
  const AIRLINES_KEY = "geofs_flight_logger_airlines";
  const LAST_AIRLINE_KEY = "geofs_flight_logger_last_airline"; // 新增：儲存上次選擇的航空公司

  let flightStarted = false;
  let flightStartTime = null;
  let departureICAO = "UNKNOWN";
  let arrivalICAO = "UNKNOWN";
  let hasLanded = false;
  let monitorInterval = null;
  let firstGroundContact = false;
  let firstGroundTime = null;
  let panelUI, startButton, callsignInput, aircraftInput, airlineSelect;
  let airportsDB = [];
  let departureAirportData = null; // 儲存起飛機場資料
  let arrivalAirportData = null;   // 儲存降落機場資料

  // ====== Load airports database ======
  fetch("https://raw.githubusercontent.com/seabus0316/GeoFS-METAR-system/refs/heads/main/airports_with_tz.json")
    .then(r => r.json())
    .then(data => {
      airportsDB = Object.entries(data).map(([icao, info]) => ({ icao, ...info }));
      console.log(`✅ Loaded ${airportsDB.length} airports`);
    })
    .catch(err => console.error("❌ Airport DB load failed:", err));

  function getNearestAirport(lat, lon) {
    if (!airportsDB.length) return { icao: "UNKNOWN" };
    let nearest = null, minDist = Infinity;
    for (const ap of airportsDB) {
      const dLat = (ap.lat - lat) * Math.PI / 180;
      const dLon = (ap.lon - lon) * Math.PI / 180;
      const a = Math.sin(dLat/2) ** 2 +
        Math.cos(lat * Math.PI/180) * Math.cos(ap.lat * Math.PI/180) *
        Math.sin(dLon/2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const dist = 6371 * c;
      if (dist < minDist) {
        minDist = dist;
        nearest = ap;
      }
    }
    if (nearest && minDist > 30) return null; // 返回 null 而非 UNKNOWN
    return nearest || null; // 返回 null 而非 UNKNOWN
  }

  function saveSession() {
    const session = {
      flightStarted,
      flightStartTime,
      departureICAO,
      callsign: callsignInput?.value.trim() || "Unknown",
      aircraft: aircraftInput?.value.trim() || "Unknown",
      firstGroundContact,
      departureAirportData,
      timestamp: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function loadSession() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function promptForAirportICAO(type, lat, lon) {
    const locationStr = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const icao = prompt(`❓ ${type} airport not found in database.\nLocation: ${locationStr}\n\nPlease enter the ICAO code manually (or leave empty for UNKNOWN):`);
    return icao ? icao.toUpperCase().trim() : "UNKNOWN";
  }

  // 航空公司管理功能
  function saveAirlines(airlines) {
    localStorage.setItem(AIRLINES_KEY, JSON.stringify(airlines));
  }

  function loadAirlines() {
    const stored = localStorage.getItem(AIRLINES_KEY);
    if (stored) {
      const airlines = JSON.parse(stored);
      // 檢查是否需要升級舊格式
      const firstKey = Object.keys(airlines)[0];
      if (firstKey && typeof airlines[firstKey] === 'string') {
        // 舊格式，需要升級
        console.log("📦 Upgrading airline data format...");
        const upgraded = {};
        for (const [name, webhook] of Object.entries(airlines)) {
          upgraded[name] = {
            webhook: webhook,
            icao: name === 'Default' ? 'GFS' : 'UNK'
          };
        }
        saveAirlines(upgraded);
        return upgraded;
      }
      return airlines;
    }
    return {
      "Default": {
        webhook: WEBHOOK_URL,
        icao: "GFS"
      }
    };
  }

  // 新增：儲存上次選擇的航空公司
  function saveLastAirline(airlineName) {
    localStorage.setItem(LAST_AIRLINE_KEY, airlineName);
  }

  // 新增：載入上次選擇的航空公司
  function loadLastAirline() {
    return localStorage.getItem(LAST_AIRLINE_KEY);
  }

  function addNewAirline() {
    const name = prompt("Enter airline name:");
    if (!name) return;

    const icao = prompt("Enter airline ICAO code (e.g., EVA, CAL, CPA):");
    if (!icao) return;

    const webhook = prompt("Enter Discord webhook URL:");
    if (!webhook || !webhook.includes("discord.com/api/webhooks/")) {
      alert("Invalid webhook URL!");
      return;
    }

    const airlines = loadAirlines();
    airlines[name] = {
      webhook: webhook,
      icao: icao.toUpperCase().trim()
    };
    saveAirlines(airlines);
    updateAirlineSelect();
    alert(`Added airline: ${name} (${icao.toUpperCase()})`);
  }

  function removeAirline() {
    const airlines = loadAirlines();
    const airlineNames = Object.keys(airlines);

    if (airlineNames.length <= 1) {
      alert("Cannot remove the last airline!");
      return;
    }

    const airlineList = airlineNames.map(name => {
      const icao = airlines[name].icao || airlines[name];
      return typeof airlines[name] === 'object' ? `${name} (${icao})` : name;
    }).join(", ");

    const selected = prompt(`Enter airline name to remove:\n${airlineList}`);
    if (selected && airlines[selected]) {
      delete airlines[selected];
      saveAirlines(airlines);
      updateAirlineSelect();
      alert(`Removed airline: ${selected}`);
    } else {
      alert("Airline not found!");
    }
  }

  function updateAirlineSelect() {
    const airlines = loadAirlines();
    const lastAirline = loadLastAirline(); // 載入上次選擇的航空公司

    airlineSelect.innerHTML = "";

    for (const [name, airlineData] of Object.entries(airlines)) {
      const option = document.createElement("option");

      // 處理舊格式和新格式的相容性
      if (typeof airlineData === 'string') {
        // 舊格式：直接是 webhook URL
        option.value = airlineData;
        option.textContent = name;
      } else {
        // 新格式：包含 webhook 和 ICAO
        option.value = airlineData.webhook;
        option.textContent = `${name} (${airlineData.icao})`;
      }

      option.setAttribute('data-airline-name', name); // 設定屬性以便後續取得航空公司名稱
      airlineSelect.appendChild(option);
    }

    // 如果有上次的選擇，自動選擇它
    if (lastAirline) {
      const targetOption = Array.from(airlineSelect.options).find(
        option => option.getAttribute('data-airline-name') === lastAirline
      );
      if (targetOption) {
        airlineSelect.value = targetOption.value;
        console.log(`✅ Restored last selected airline: ${lastAirline}`);
      }
    }

    // 當選擇改變時，儲存新的選擇（移除重複的事件監聽器）
    airlineSelect.removeEventListener('change', airlineChangeHandler);
    airlineSelect.addEventListener('change', airlineChangeHandler);
  }

  // 定義事件處理器函數，避免重複綁定
  function airlineChangeHandler() {
    const selectedOption = airlineSelect.options[airlineSelect.selectedIndex];
    const airlineName = selectedOption.getAttribute('data-airline-name');
    if (airlineName) {
      saveLastAirline(airlineName);
      console.log(`💾 Saved airline selection: ${airlineName}`);
    }
  }

  function getCurrentWebhookURL() {
    const airlines = loadAirlines();
    const selectedOption = airlineSelect.options[airlineSelect.selectedIndex];
    const airlineName = selectedOption?.getAttribute('data-airline-name');

    if (airlineName && airlines[airlineName]) {
      const airlineData = airlines[airlineName];
      // 處理新格式和舊格式的相容性
      return typeof airlineData === 'object' ? airlineData.webhook : airlineData;
    }

    return airlineSelect.value || WEBHOOK_URL;
  }

  // 新增：取得當前選擇的航空公司 ICAO 代碼
  function getCurrentAirlineICAO() {
    const airlines = loadAirlines();
    const selectedOption = airlineSelect.options[airlineSelect.selectedIndex];
    const airlineName = selectedOption?.getAttribute('data-airline-name');

    if (airlineName && airlines[airlineName]) {
      const airlineData = airlines[airlineName];
      return typeof airlineData === 'object' ? airlineData.icao : 'GFS';
    }
    return 'GFS';
  }

  function formatTimeWithTimezone(timestamp, airportData) {
    // 如果有機場時區資料，使用機場時區，否則使用UTC
    let timeZone = 'UTC';
    let suffix = 'UTC';

    if (airportData && airportData.tz) {
      timeZone = airportData.tz;
      // 取得時區簡寫 (例如 Asia/Taipei -> CST)
      const date = new Date(timestamp);
      const timezoneName = date.toLocaleDateString('en', {
        timeZone: timeZone,
        timeZoneName: 'short'
      }).split(', ')[1] || timeZone.split('/')[1] || 'LT';
      suffix = timezoneName;
    }

    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    return `${fmt.format(new Date(timestamp))} ${suffix}`;
  }

  function sendLogToDiscord(data) {
    // 使用起飛和降落機場的本地時間
    const takeoffTime = formatTimeWithTimezone(data.takeoff, departureAirportData);
    const landingTime = formatTimeWithTimezone(data.landing, arrivalAirportData);

    // 根據降落品質決定顏色
    let embedColor;
    switch(data.landingQuality) {
      case "BUTTER": embedColor = 0x00FF00; break; // 綠色
      case "HARD": embedColor = 0xFF8000; break;   // 橘色
      case "CRASH": embedColor = 0xFF0000; break;  // 紅色
      default: embedColor = 0x0099FF; break;       // 藍色
    }

    const message = {
      embeds: [{
        title: "🛫 Flight Report - GeoFS",
        color: embedColor,
        fields: [
          {
            name: "✈️ Flight Information",
            value: `**Pilot**: ${data.pilot}\n**Aircraft**: ${data.aircraft}`,
            inline: false
          },
          {
            name: "📍 Route",
            value: `**Departure**: ${data.dep}\n**Arrival**: ${data.arr}`,
            inline: true
          },
          {
            name: "⏱️ Duration",
            value: `**Flight Time**: ${data.duration}`,
            inline: true
          },
          {
            name: "📊 Flight Data",
            value: `**V/S**: ${data.vs} fpm\n**G-Force**: ${data.gforce}\n**TAS**: ${data.ktrue} kts\n**GS**: ${data.gs} kts`,
            inline: true
          },
          {
            name: "🏁 Landing Quality",
            value: `**${data.landingQuality}**`,
            inline: true
          },
          {
            name: "🕓 Times",
            value: `**Takeoff**: ${takeoffTime}\n**Landing**: ${landingTime}`,
            inline: false
          }
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: "GeoFS Flight Logger"
        }
      }]
    };

    fetch(getCurrentWebhookURL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    }).then(() => console.log("✅ Flight log sent"))
      .catch(console.error);
  }

  function monitorFlight() {
    if (!geofs?.animation?.values || !geofs.aircraft?.instance) return;
    const values = geofs.animation.values;
    const onGround = values.groundContact;
    const altitudeFt = values.altitude * 3.28084;
    const terrainFt = geofs.api?.map?.getTerrainAltitude?.() * 3.28084 || 0;
    const agl = altitudeFt - terrainFt;
    const [lat, lon] = geofs.aircraft.instance.llaLocation || [values.latitude, values.longitude];
    const now = Date.now();

    if (!flightStarted && !onGround && agl > 100) {
      flightStarted = true;
      flightStartTime = now;
      const nearestAirport = getNearestAirport(lat, lon);
      if (nearestAirport) {
        departureICAO = nearestAirport.icao;
        departureAirportData = nearestAirport;
      } else {
        // 沒找到機場，詢問用戶
        departureICAO = promptForAirportICAO("Departure", lat, lon);
        departureAirportData = null; // 手動輸入的機場沒有時區資料
      }
      saveSession();
      console.log(`🛫 Departure detected at ${departureICAO}`);
      if (panelUI) {
        // 檢查是否需要隱藏面板（飛行開始時）
        if (window.instruments && window.instruments.visible) {
          panelUI.style.opacity = "0";
          setTimeout(() => panelUI.style.display = "none", 500);
        }
      }
    }

    const elapsed = (now - flightStartTime) / 1000;
    if (flightStarted && !firstGroundContact && onGround) {
      if (elapsed < 1) return;
      const vs = values.verticalSpeed;
      if (vs <= -800) {
        alert("⚠️ CRASH DETECTED: Logging crash report.");
        arrivalICAO = "Crash";
        arrivalAirportData = null;
      } else {
        const nearestAirport = getNearestAirport(lat, lon);
        if (nearestAirport) {
          arrivalICAO = nearestAirport.icao;
          arrivalAirportData = nearestAirport;
        } else {
          // 沒找到機場，詢問用戶
          arrivalICAO = promptForAirportICAO("Arrival", lat, lon);
          arrivalAirportData = null; // 手動輸入的機場沒有時區資料
        }
      }
      console.log(`🛬 Arrival detected at ${arrivalICAO}`);
      firstGroundContact = true;
      firstGroundTime = now;

      const g = (values.accZ / 9.80665).toFixed(2);
      const gs = values.groundSpeedKnt.toFixed(1);
      const tas = geofs.aircraft.instance.trueAirSpeed?.toFixed(1) || "N/A";
      const quality = (vs > -60) ? "BUTTER" : (vs > -800) ? "HARD" : "CRASH";
      const baseCallsign = callsignInput.value.trim() || "Unknown";
      const airlineICAO = getCurrentAirlineICAO();
      // 自動在 callsign 前面加上 ICAO 代碼（如果還沒有的話）
      const pilot = baseCallsign.toUpperCase().startsWith(airlineICAO) ?
        baseCallsign : `${airlineICAO}${baseCallsign}`;
      const aircraft = aircraftInput.value.trim() || "Unknown";
      const durationMin = Math.round((firstGroundTime - flightStartTime) / 60000);

      // 轉換飛行時間為 hh:mm 格式
      const hours = Math.floor(durationMin / 60);
      const minutes = durationMin % 60;
      const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

      sendLogToDiscord({
        pilot, aircraft,
        takeoff: flightStartTime,
        landing: firstGroundTime,
        dep: departureICAO,
        arr: arrivalICAO,
        duration: formattedDuration,
        vs: vs.toFixed(1),
        gforce: g,
        gs: gs,
        ktrue: tas,
        landingQuality: quality
      });

      saveSession();
      clearSession();
      resetPanel();

      if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
      }
    }
  }

  function resetPanel() {
    flightStarted = false;
    hasLanded = false;
    firstGroundContact = false;
    flightStartTime = null;
    departureICAO = "UNKNOWN";
    arrivalICAO = "UNKNOWN";
    departureAirportData = null;
    arrivalAirportData = null;
    callsignInput.value = "";
    aircraftInput.value = "";
    startButton.disabled = true;
    startButton.innerText = "📋 Start Flight Logger";
    if (panelUI) {
      // 只有在 instruments 可見時才顯示面板
      if (window.instruments && window.instruments.visible) {
        panelUI.style.display = "block";
        panelUI.style.opacity = "0.5";
      }
    }
  }

  function disableKeyPropagation(input) {
    ["keydown", "keyup", "keypress"].forEach(ev =>
      input.addEventListener(ev, e => e.stopPropagation())
    );
  }

 function createSidePanel() {
    panelUI = document.createElement("div");
    Object.assign(panelUI.style, {
      position: "absolute",
      bottom: "50px",
      left: "10px",
      background: "#111",
      color: "white",
      padding: "10px",
      border: "2px solid white",
      zIndex: "21", // 改為與小地圖相同的層級
      width: "220px",
      fontSize: "14px",
      fontFamily: "sans-serif",
      transition: "opacity 0.5s ease",
      display: "block", // 預設顯示
      opacity: "0.5" // ← 新增透明度
    });

    // 航空公司選擇器
    const airlineLabel = document.createElement("div");
    airlineLabel.textContent = "Airline:";
    airlineLabel.style.marginBottom = "3px";
    airlineLabel.style.fontSize = "12px";
    panelUI.appendChild(airlineLabel);

    airlineSelect = document.createElement("select");
    airlineSelect.style.width = "100%";
    airlineSelect.style.marginBottom = "6px";
    panelUI.appendChild(airlineSelect);

    // 航空公司管理按鈕容器
    const airlineButtons = document.createElement("div");
    airlineButtons.style.display = "flex";
    airlineButtons.style.gap = "4px";
    airlineButtons.style.marginBottom = "6px";

    const addAirlineBtn = document.createElement("button");
    addAirlineBtn.textContent = "+ Add";
    Object.assign(addAirlineBtn.style, {
      flex: "1",
      padding: "3px",
      background: "#006600",
      color: "white",
      border: "1px solid white",
      cursor: "pointer",
      fontSize: "10px"
    });
    addAirlineBtn.onclick = addNewAirline;

    const removeAirlineBtn = document.createElement("button");
    removeAirlineBtn.textContent = "- Remove";
    Object.assign(removeAirlineBtn.style, {
      flex: "1",
      padding: "3px",
      background: "#660000",
      color: "white",
      border: "1px solid white",
      cursor: "pointer",
      fontSize: "10px"
    });
    removeAirlineBtn.onclick = removeAirline;

    airlineButtons.appendChild(addAirlineBtn);
    airlineButtons.appendChild(removeAirlineBtn);
    panelUI.appendChild(airlineButtons);

    callsignInput = document.createElement("input");
    callsignInput.placeholder = "Callsign";
    callsignInput.style.width = "100%";
    callsignInput.style.marginBottom = "6px";
    disableKeyPropagation(callsignInput);
    callsignInput.onkeyup = () => {
      startButton.disabled = callsignInput.value.trim() === "";
    };

    aircraftInput = document.createElement("input");
    aircraftInput.placeholder = "Aircraft Type (A320, B737, etc)";
    aircraftInput.style.width = "100%";
    aircraftInput.style.marginBottom = "6px";
    disableKeyPropagation(aircraftInput);

    startButton = document.createElement("button");
    startButton.innerText = "📋 Start Flight Logger";
    startButton.disabled = true;
    Object.assign(startButton.style, {
      width: "100%",
      padding: "6px",
      background: "#333",
      color: "white",
      border: "1px solid white",
      cursor: "pointer"
    });

    startButton.onclick = () => {
      alert("Flight Logger activated! Start your flight when ready.");
      monitorInterval = setInterval(monitorFlight, 1000);
      startButton.innerText = "✅ Logger Running...";
      startButton.disabled = true;
    };

    panelUI.appendChild(callsignInput);
    panelUI.appendChild(aircraftInput);
    panelUI.appendChild(startButton);

    const resumeSession = loadSession();
    const resumeBtn = document.createElement("button");
    resumeBtn.innerText = "⏪ Resume Last Flight";
    Object.assign(resumeBtn.style, {
      width: "100%",
      marginTop: "6px",
      padding: "6px",
      background: "#222",
      color: "white",
      border: "1px solid white",
      cursor: "pointer"
    });

    resumeBtn.onclick = () => {
      if (resumeSession) {
        flightStarted = true;
        flightStartTime = resumeSession.flightStartTime;
        departureICAO = resumeSession.departureICAO;
        departureAirportData = resumeSession.departureAirportData;
        firstGroundContact = resumeSession.firstGroundContact || false;
        callsignInput.value = resumeSession.callsign || "";
        aircraftInput.value = resumeSession.aircraft || "";
        monitorInterval = setInterval(monitorFlight, 1000);
        resumeBtn.innerText = "✅ Resumed!";
        resumeBtn.disabled = true;
        startButton.innerText = "✅ Logger Running...";
        startButton.disabled = true;
        console.log("🔁 Resumed flight session.");
        if (panelUI && window.instruments && window.instruments.visible) {
          panelUI.style.opacity = "0";
          setTimeout(() => panelUI.style.display = "none", 500);
        }
      } else {
        alert("❌ No previous session found.");
      }
    };

    panelUI.appendChild(resumeBtn);
    document.body.appendChild(panelUI);

    // 初始化航空公司選單
    updateAirlineSelect();
  }

  function updatePanelVisibility() {
    if (panelUI) {
      // 檢查 GeoFS instruments 是否可見
      panelUI.style.display = (window.instruments && window.instruments.visible) ? "block" : "none";
    }
    // 每 100ms 檢查一次
    setTimeout(updatePanelVisibility, 100);
  }

  window.addEventListener("load", () => {
    console.log("✅ GeoFS Flight Logger (Auto ICAO, CDN JSON) Loaded");
    createSidePanel();
    // 開始監控 UI 顯示狀態
    setTimeout(updatePanelVisibility, 1000); // 延遲 1 秒後開始監控，確保 GeoFS 完全載入
  });
})();
