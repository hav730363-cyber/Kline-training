// Optional research dashboard. It never starts a market scan without a click.
(() => {
  const byId = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const labels = { development: "开发期", validation: "验证期", holdout: "最终留出期", stock: "A股", etf: "ETF" };
  const defaults = { "personal-j-low": 10, "personal-j-high": 75, "price-volume-context": 1.5, "estimated-volume-profile": 60 };
  let status = null;
  let report = null;
  let rules = [];
  let polling = null;

  async function api(path, body) {
    const response = await fetch(`/api/research/${path}`, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
  }

  function textStatus(value) { byId("researchStatus").textContent = value; }
  function pct(value) { return value == null ? "—" : `${(Number(value) * 100).toFixed(2)}%`; }

  function render() {
    if (!status) return;
    const count = status.counts || {};
    const coverage = report?.coverage || {};
    const taskLabel = { idle: "尚未启动", running: "正在研究", paused: "已暂停，可继续", complete: "名单扫描结束" }[status.state] || status.state;
    const validation = status.ruleValidation || {};
    const validationText = validation.state === "running" ? ` · 规则 ${validation.ruleId} v${validation.revision} 正在重新验证` : validation.state === "failed" ? ` · 规则重验失败：${validation.error}` : "";
    textStatus(`${taskLabel} · 已处理 ${count.complete || 0}/${status.universeCount || coverage.universe || "待获取"} · 失败 ${count.failed || 0} · 候选事件 ${status.events || 0} · 完整分时日 ${status.intradayDays || 0}${status.reason ? ` · ${status.reason}` : ""}${status.error ? ` · ${status.error}` : ""}${validationText}`);
    byId("researchPilotButton").disabled = status.state === "running";
    byId("researchStartButton").disabled = status.state === "running" || validation.state === "running";
    byId("researchProposeButton").disabled = status.state === "running" || validation.state === "running";
    byId("researchPauseButton").disabled = status.state !== "running";
    byId("researchRetryValidationButton").hidden = !["interrupted", "failed"].includes(validation.state);
    const dates = coverage.dates || status.dates || {};
    const excluded = coverage.excluded || {};
    const dailyCoverage = (report?.dailyCoverage || []).map((item) => `${labels[item.kind]} ${item.symbols}只/${item.days}交易日（${item.firstDate}—${item.lastDate}）`).join("；") || "暂无";
    const minuteCoverage = report?.intradayCoverage || {};
    byId("researchCoverage").innerHTML = `<div><b>时间切分</b><span>${esc(dates.start || "—")} 至 ${esc(dates.end || "—")}；开发期至 ${esc(dates.developmentEnd || "—")}，验证期至 ${esc(dates.validationEnd || "—")}</span></div>
      <div><b>数据口径</b><span>BaoStock · 前复权日线 · 候选日 5 分钟不复权量价 · 仅存续标的，存在幸存者偏差<br>实际覆盖：${esc(dailyCoverage)}<br>${esc(coverage.feeAssumption || "")}</span></div>
      <div><b>排除与缺失</b><span>ST 日 ${excluded.stDays || 0} · 停牌日 ${excluded.suspendedDays || 0} · 历史状态不明 ${excluded.unknownStatusDays || 0} · 无效行 ${excluded.invalidRows || 0} · 历史不足标的 ${excluded.insufficientSymbols || count.insufficient || 0} · 失败标的 ${excluded.failedSymbols || count.failed || 0}<br>分时完整 ${minuteCoverage.complete || 0} 日；不完整 ${minuteCoverage.incomplete || 0} 日；不可用 ${minuteCoverage.unavailable || 0} 日</span></div>`;
    const groups = report?.groups || [];
    const selector = byId("researchRuleSelect");
    const selected = selector.value;
    selector.querySelectorAll("option[data-custom-rule]").forEach((option) => option.remove());
    for (const rule of rules.filter((item) => item.id.startsWith("custom-") && item.revision === Math.max(...rules.filter((other) => other.id === item.id).map((other) => other.revision)))) {
      const option = document.createElement("option"); option.value = rule.id; option.textContent = rule.title; option.dataset.customRule = "true"; selector.append(option);
    }
    selector.value = selected && [...selector.options].some((option) => option.value === selected) ? selected : "personal-j-low";
    const eligible = new Map();
    for (const group of groups) if (group.evidence === "样本外统计可查；仍需人工确认") {
      const key = `${group.ruleId}:${group.revision}`;
      eligible.set(key, new Set([...(eligible.get(key) || []), `${group.kind}:${group.split}`]));
    }
    const rows = groups.map((group) => {
      const rule = rules.find((item) => item.id === group.ruleId && item.revision === group.revision);
      const horizons = [5, 10, 20].map((days) => {
        const item = group.horizons?.[String(days)] || {};
        return `${days}日：${item.count || 0}例，净均值 ${pct(item.meanNet)}，不利结果占比 ${item.downsideRate == null ? "—" : pct(item.downsideRate)}`;
      }).join(" · ");
      const canApprove = report.status === "complete" && group.kind === "stock" && group.split === "holdout" && !rule?.approved
        && ["stock:validation", "stock:holdout", "etf:validation", "etf:holdout"].every((key) => eligible.get(`${group.ruleId}:${group.revision}`)?.has(key));
      const previous = groups.find((item) => item.ruleId === group.ruleId && item.revision === group.revision - 1 && item.kind === group.kind && item.split === group.split);
      const current20 = group.horizons?.["20"]?.meanNet;
      const previous20 = previous?.horizons?.["20"]?.meanNet;
      const difference = current20 == null || previous20 == null ? "" : ` · 相对上一版20日均值变化 ${pct(current20 - previous20)}`;
      return `<article class="research-result"><div><strong>${esc(rule?.title || group.ruleId)} · v${group.revision} · ${esc(labels[group.kind])} · ${esc(labels[group.split])}</strong>
        <span>${group.signals} 次信号 / ${group.symbols} 只标的 · ${esc(group.evidence)}${rule?.approved ? " · 已经你确认启用" : " · 尚未启用"}</span></div>
        <p>${esc(horizons)}</p><small>10%尾部净值 ${pct(group.horizons?.["20"]?.p10Net)}${esc(difference)}；结果按下一可交易日开盘价至未来收盘价估算，扣除研究用往返费用；缺少后续行情 ${group.missingOutcomes} 例。</small>
        ${canApprove ? `<button class="secondary-button" type="button" data-approve-rule="${esc(group.ruleId)}" data-approve-revision="${group.revision}">确认启用此版本</button>` : ""}</article>`;
    });
    byId("researchReport").innerHTML = `${report?.status === "partial" ? '<p class="trade-hint">当前仅为部分样本报告，不得据此启用规则。</p>' : ""}
      <p class="trade-hint">${esc(report?.intradaySampling || "分时仅用于候选日背景核查，不参与日线信号判定。")}</p>
      ${rows.join("") || '<p class="trade-hint">尚无可核对的事件；先试跑或继续研究。</p>'}
      ${(report?.failureExamples || []).length ? `<details><summary>失败标的示例</summary>${report.failureExamples.map((item) => `<p class="trade-hint">${esc(item.symbol)}：${esc(item.reason)}</p>`).join("")}</details>` : ""}`;
    const approved = {};
    for (const rule of rules) if (rule.approved) approved[rule.id] = rule;
    window.KLINE_RESEARCH_STATE = { status, report, rules, approved };
    if (typeof renderReviewRuleReferences === "function" && !byId("operationReview").hidden) renderReviewRuleReferences();
  }

  async function refresh() {
    try {
      [status, report, { rules }] = await Promise.all([api("status"), api("report"), api("rules")]);
      render();
      if ((status.state === "running" || status.ruleValidation?.state === "running") && !polling) polling = setInterval(refresh, 4000);
      if (status.state !== "running" && status.ruleValidation?.state !== "running" && polling) { clearInterval(polling); polling = null; }
    } catch (error) {
      textStatus(`研究服务暂不可用：${error.message}。现有训练不受影响。`);
      if (polling) { clearInterval(polling); polling = null; }
    }
  }

  async function act(path, body, label) {
    try { textStatus(`${label}…`); await api(path, body); await refresh(); }
    catch (error) { textStatus(`${label}失败：${error.message}`); }
  }

  byId("researchPilotButton").addEventListener("click", () => act("start", { maxSymbols: 5 }, "启动试跑"));
  byId("researchStartButton").addEventListener("click", () => act("start", {}, "继续研究"));
  byId("researchPauseButton").addEventListener("click", () => act("pause", {}, "暂停任务"));
  byId("researchRetryValidationButton").addEventListener("click", () => act("retry-validation", {}, "继续规则重验"));
  byId("researchRefreshButton").addEventListener("click", refresh);
  byId("researchRuleSelect").addEventListener("change", (event) => {
    byId("researchThreshold").value = rules.find((rule) => rule.id === event.target.value)?.threshold ?? defaults[event.target.value];
  });
  byId("researchProposeButton").addEventListener("click", () => act("propose", {
    ruleId: byId("researchRuleSelect").value, threshold: Number(byId("researchThreshold").value),
    source: byId("researchSource").value.trim(), url: byId("researchUrl").value.trim(), title: byId("researchNewTitle").value.trim(),
  }, "提交候选版本"));
  byId("researchReport").addEventListener("click", (event) => {
    const button = event.target.closest("[data-approve-rule]");
    if (button) act("approve", { ruleId: button.dataset.approveRule, revision: Number(button.dataset.approveRevision) }, "确认启用");
  });
  refresh();
})();
