// public/widget-loader.js
(function () {
  // Grab the script tag and bot id
  const s = document.currentScript;
  if (!s) {
    console.error("widget-loader: currentScript not found");
    return;
  }
  const botId = s.getAttribute("data-bot-id");
  if (!botId) {
    console.error("widget-loader: bot id missing in data-bot-id attribute");
    return;
  }

  // Use the script's own origin so it works on localhost or your domain
  const origin = new URL(s.src, window.location.href).origin; // e.g., http://localhost:3000

  // Create floating chat button
  const btn = document.createElement("button");
  btn.setAttribute("aria-label", "Open chat");
  Object.assign(btn.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    width: "56px",
    height: "56px",
    borderRadius: "50%",
    background: "#0b84ff",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    zIndex: 2147483647, // on top of everything
    boxShadow: "0 6px 16px rgba(0,0,0,0.25)",
    fontSize: "22px",
  });
  btn.textContent = "💬";
  document.body.appendChild(btn);

  // Create iframe (hidden)
  const iframe = document.createElement("iframe");
  iframe.src = origin + "/embed.html?botId=" + encodeURIComponent(botId);
  Object.assign(iframe.style, {
    position: "fixed",
    right: "20px",
    bottom: "90px",
    width: "380px",
    height: "520px",
    border: "none",
    display: "none",
    zIndex: 2147483647,
    borderRadius: "12px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
    background: "#fff",
  });
  document.body.appendChild(iframe);

  // Toggle open/close
  btn.addEventListener("click", () => {
    iframe.style.display = iframe.style.display === "none" ? "block" : "none";
  });
})();
