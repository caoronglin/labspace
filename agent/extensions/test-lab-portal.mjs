#!/usr/bin/env node
/**
 * lab-portal 插件自测脚本
 *
 * 直接 import 插件文件，用假的 pi 对象收集注册的工具，然后逐个执行，
 * 验证「工具 → 门户内部接口」这条链路是通的。
 *
 * 用法：
 *   LAB_PORTAL_URL=http://192.0.2.10 \
 *   LAB_PORTAL_TOKEN=<服务令牌> \
 *   node test-lab-portal.mjs
 *
 * 说明：插件的每个工具 execute 都会返回 { output } 或 { error } 形状的对象；
 * 本脚本只做「是否成功返回 + 是否包含关键字段」级别的断言，不做严格文案比对。
 */

import labPortalExtension from "./lab-portal.js";

const BASE = (process.env.LAB_PORTAL_URL || "http://192.0.2.10").replace(/\/+$/, "");
const TOKEN = process.env.LAB_PORTAL_TOKEN || "";
// LAB_PORTAL_BEARER = 用户会话 JWT（由 Agent 网关注入）。
// 只有服务令牌时，用户级接口（个人工作台）应当被拒绝——这属于预期行为。
const BEARER = process.env.LAB_PORTAL_BEARER || "";
const HAS_BEARER = Boolean(BEARER);

/* -------------------------------------------------- 收集注册的工具 */

const tools = new Map();
const fakePi = {
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
};

labPortalExtension(fakePi);

let failed = 0;
function record(name, ok, detail) {
	const tag = ok ? "[ OK ]" : "[FAIL]";
	if (!ok) failed += 1;
	console.log(`  ${tag} ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`门户地址: ${BASE}`);
console.log(`令牌: ${TOKEN ? "已提供" : "未提供（可能 401）"}`);
console.log(`注册工具: ${[...tools.keys()].join(", ")}`);
console.log("");

if (!TOKEN) {
	console.log("缺少 LAB_PORTAL_TOKEN，无法完成鉴权类用例。");
	process.exit(2);
}

/* -------------------------------------------------- 用例 */

console.log("== 1. lab_services ==");
{
	const tool = tools.get("lab_services");
	const res = await tool.execute("call-1", { q: "" });
	const text = (res.content || []).map((c) => c.text || "").join("\n");
	const ok = !res.isError && /服务|URL/i.test(text);
	record("lab_services 返回服务清单", ok, text.slice(0, 120));
}

console.log("\n== 2. lab_database_query ==");
{
	const tool = tools.get("lab_database_query");
	const res = await tool.execute("call-2", { database: "NCBI", query: "Arabidopsis thaliana", limit: 3 });
	const text = (res.content || []).map((c) => c.text || "").join("\n");
	const ok = !res.isError && text.length > 10;
	record("lab_database_query 返回结果", ok, text.slice(0, 160));
}

console.log("\n== 3. lab_web_search ==");
{
	const tool = tools.get("lab_web_search");
	const res = await tool.execute("call-3", { query: "plant genome" });
	const text = (res.content || []).map((c) => c.text || "").join("\n");
	const ok = !res.isError && text.length > 10;
	record("lab_web_search 返回结果", ok, text.slice(0, 160));
}

console.log("\n== 4. lab_workbench_list ==");
{
	const tool = tools.get("lab_workbench_list");
	const res = await tool.execute("call-4", { limit: 3 });
	const text = (res.content || []).map((c) => c.text || "").join("\n");
	if (HAS_BEARER) {
		const ok = !res.isError && text.length > 0;
		record("lab_workbench_list 返回条目", ok, text.slice(0, 160));
	} else {
		// 仅服务令牌：用户级接口必须被拒绝
		const ok = res.isError && /401|未登录|会话/.test(text);
		record("lab_workbench_list 无用户令牌时被拒绝（预期）", ok, text.slice(0, 160));
	}
}

console.log("");
console.log(failed === 0 ? "结果: 全部通过" : `结果: 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
