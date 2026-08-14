window.__ModuleLoader__.load({
  id: "@kaze/dsh-im",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var P = require("@deepseek-ai/dsh-client-ui-primitives");

    // DSH theme tokens (defined globally; adapt to light/dark automatically).
    var T = {
      text: "var(--dsw-alias-label-primary)",
      textMuted: "var(--dsw-alias-label-secondary)",
      textTertiary: "var(--dsw-alias-label-tertiary)",
      border: "var(--dsw-alias-border-l)",
      ok: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      err: "var(--dsw-alias-state-error-primary)",
    };

    function Dot(color) {
      return React.createElement("span", {
        style: { display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0, verticalAlign: "middle" },
      });
    }

    var groupStyle = { marginBottom: 22 };
    var titleStyle = { fontSize: 13, fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 8, color: T.text };
    var rowStyle = { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 };
    var mutedStyle = { fontSize: 12, color: T.textMuted };
    var errStyle = { fontSize: 12, color: T.err, marginBottom: 8, wordBreak: "break-word" };

    function useImStatus() {
      var statusState = React.useState(null);
      var setStatus = statusState[1];
      React.useEffect(function () {
        var disposed = false;
        var load = function () {
          fetch("/im/status")
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { if (d && !disposed) setStatus(d); })
            .catch(function () {});
        };
        load();
        var timer = setInterval(load, 3000);
        return function () { disposed = true; clearInterval(timer); };
      }, []);
      return statusState[0];
    }

    function ImSettingsSection() {
      var status = useImStatus();
      var editingState = React.useState(false);
      var editing = editingState[0];
      var setEditing = editingState[1];
      var tokenState = React.useState("");
      var token = tokenState[0];
      var setToken = tokenState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var post = function (url, body) {
        setBusy(true);
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (d) { setStatus(d); setEditing(false); setToken(""); } })
          .catch(function (e) { console.error("[dsh-im]", e); })
          .finally(function () { setBusy(false); });
      };

      var telegram = status && status.telegram;
      var wechat = status && status.wechat;
      var configured = !!(telegram && telegram.tokenConfigured);
      var teleColor = telegram && telegram.connected ? T.ok : (telegram && telegram.enabled ? T.warn : T.textTertiary);
      var wxColor = wechat && wechat.loggedIn ? T.ok : (wechat && wechat.scanning ? T.warn : T.textTertiary);

      // ---- Telegram ----
      var teleStatus = telegram && telegram.enabled
        ? (telegram.connected ? "Connected" : "Not connected") + (telegram.bot ? " \u00b7 @" + telegram.bot : "")
        : "Disabled";

      var teleChildren = [
        React.createElement("div", { key: "t", style: titleStyle },
          Dot(teleColor), "Telegram",
          React.createElement("span", { style: mutedStyle }, teleStatus)),
      ];

      if (!configured || editing) {
        teleChildren.push(
          React.createElement("div", { key: "in", style: rowStyle },
            React.createElement(P.Input, {
              type: "password", value: token, style: { flex: 1 },
              placeholder: editing ? "Enter new token" : "Bot token from @BotFather",
              onChange: function (e) { setToken(e.target.value); },
            }),
            React.createElement(P.Button, {
              variant: "primary", size: "sm", disabled: busy,
              onClick: function () { post("/im/telegram", { token: token }); },
            }, editing ? "Save" : "Connect")),
          editing ? React.createElement(P.Button, {
            key: "cancel", variant: "ghost", size: "sm", disabled: busy,
            onClick: function () { setEditing(false); setToken(""); },
          }, "Cancel") : null);
      } else {
        teleChildren.push(
          React.createElement("div", { key: "cfg", style: rowStyle },
            React.createElement("span", { style: mutedStyle }, "Token configured"),
            React.createElement(P.Button, { variant: "ghost", size: "sm", disabled: busy, onClick: function () { setEditing(true); setToken(""); } }, "Change"),
            React.createElement(P.Button, { variant: "outline", size: "sm", disabled: busy, onClick: function () { post("/im/telegram", { token: "" }); } }, "Disconnect")));
      }
      if (telegram && telegram.error) teleChildren.push(React.createElement("div", { key: "err", style: errStyle }, telegram.error));

      // ---- WeChat ----
      var wxStatus = wechat && wechat.loggedIn
        ? "Connected" + (wechat.userName ? " \u00b7 " + wechat.userName : "")
        : wechat && wechat.scanning
          ? "Waiting for scan"
          : wechat && wechat.enabled ? "Not connected" : "Disabled";

      var wxChildren = [
        React.createElement("div", { key: "t", style: titleStyle },
          Dot(wxColor), "WeChat",
          React.createElement("span", { style: mutedStyle }, wxStatus)),
      ];

      if (wechat && wechat.scanning && wechat.qrcode) {
        wxChildren.push(React.createElement("div", { key: "qr", style: { textAlign: "center", margin: "4px 0 12px" } },
          React.createElement("img", {
            src: wechat.qrcode, alt: "WeChat QR",
            style: { width: 220, height: 220, borderRadius: 10, border: "1px solid " + T.border },
          }),
          React.createElement("div", { style: { marginTop: 8, fontSize: 12, color: T.textMuted } },
            "Scan with WeChat to connect the AI bot")));
      }

      wxChildren.push(React.createElement("div", { key: "btn", style: rowStyle },
        wechat && wechat.loggedIn
          ? React.createElement(P.Button, { variant: "outline", size: "sm", disabled: busy, onClick: function () { post("/im/wechat/logout"); } }, "Disconnect")
          : React.createElement(P.Button, { variant: "primary", size: "sm", disabled: busy, onClick: function () { post("/im/wechat/start"); } }, "Scan to connect"),
        wechat && wechat.enabled && !wechat.loggedIn && !wechat.scanning
          ? React.createElement("span", { style: mutedStyle }, "Connecting...") : null));
      if (wechat && wechat.error) wxChildren.push(React.createElement("div", { key: "err", style: errStyle }, wechat.error));

      return React.createElement("div", null,
        React.createElement("div", { style: groupStyle }, teleChildren),
        React.createElement("div", null, wxChildren));
    }

    // --- cordis client plugin ----------------------------------------------
    var inject = ["slots"];
    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "im-bridge",
          order: 100,
          label: "IM Bridge",
        }, ImSettingsSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
