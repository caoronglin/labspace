/**
 * Lab Portal Extension (实验室能力插件)
 *
 * 让 pi 助手可以调用实验室门户（内网 FastAPI）的内部接口：
 *   - 内网服务清单（/api/services）
 *   - 植物数据库查询（/api/databases、/api/databases/{id}/query）
 *   - 统一搜索（/api/search?scope=web）
 *   - 个人工作台智能捕获与条目查询（/api/workbench/capture、/api/workbench/items）
 *
 * 导出形式与注册方式严格照抄官方示例：
 *   examples/extensions/hello.ts      -> export default function (pi) { pi.registerTool(helloTool) }
 *   examples/extensions/tools.ts      -> pi.registerTool({ name, label, description, parameters, execute })
 *   examples/extensions/todo.ts       -> parameters: Type.Object({...})（TypeBox）
 *
 * 说明（与官方示例的唯一结构性差异）：本文件是纯 JS（ESM），因此不 import "typebox"，
 * 而是直接写出 TypeBox `Type.Object(...)` 编译后等价的 JSON Schema 文本。
 * pi 侧用 typebox 的 Compile 校验参数（见 pi-ai/dist/utils/validation.js），
 * 对普通 JSON Schema 同样生效；同时本文件可以被 node 直接 import 来自测。
 *
 * 内部调用约定：
 *   请求头 X-Lab-Service-Token: <LAB_PORTAL_TOKEN>
 *   门户地址 LAB_PORTAL_URL（默认 http://192.0.2.10）
 */

const DEFAULT_BASE_URL = "http://192.0.2.10";
const REQUEST_TIMEOUT_MS = 15000;
const DATABASE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_QUERY_LIMIT = 5;
const MAX_QUERY_LIMIT = 20;
const SEARCH_RESULT_LIMIT = 8;

/* ------------------------------------------------------------------ 参数 schema */

/** lab_services 参数：q 可选 */
const ServicesParams = {
	type: "object",
	properties: {
		q: {
			type: "string",
			description: "可选。按名称/说明/分类/URL 做本地过滤的关键词（不区分大小写）；留空返回全部服务。",
		},
	},
};

/** lab_database_query 参数 */
const DatabaseQueryParams = {
	type: "object",
	properties: {
		database: {
			type: "string",
			description: "数据库名称或 id，支持中文名/英文名/id 模糊匹配。例：\"NCBI GenBank\"、\"genbank\"。",
		},
		query: {
			type: "string",
			description: "要在该数据库中检索的关键词。例：\"Arabidopsis thaliana\"。",
		},
		limit: {
			type: "number",
			description: "可选。返回条数上限，默认 5，最大 20。",
		},
	},
	required: ["database", "query"],
};

/** lab_web_search 参数 */
const WebSearchParams = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "搜索关键词。例：\"拟南芥 胁迫 干旱\"。",
		},
	},
	required: ["query"],
};

/** lab_workbench_capture 参数 */
const WorkbenchCaptureParams = {
	type: "object",
	properties: {
		text: {
			type: "string",
			description:
				"要记入工作台的一句话。可含日期（今天/明天/2026-11-05）、#标签、优先级词（紧急/不急）。例：\"明天下午前完成 #实验 蛋白提取\"。",
		},
	},
	required: ["text"],
};

/** lab_workbench_list 参数 */
const WorkbenchListParams = {
	type: "object",
	properties: {
		kind: {
			type: "string",
			description:
				"可选。按条目类型过滤：task/project/idea/knowledge/note/memory/plan；留空返回全部类型。",
		},
		limit: {
			type: "number",
			description: "可选。返回条数上限，默认 20，最大 200。",
		},
	},
};

/** lab_knowledge_search 参数 */
const KnowledgeSearchParams = {
	type: "object",
	properties: {
		q: {
			type: "string",
			description: "可选。按标题、正文或标签检索；留空返回最近的条目。",
		},
		limit: {
			type: "number",
			description: "可选。返回条数上限，默认 10，最大 50。",
		},
	},
};

/** lab_knowledge_save 参数 */
const KnowledgeSaveParams = {
	type: "object",
	properties: {
		title: { type: "string", description: "条目标题，最多 200 字。" },
		body: { type: "string", description: "正文，纯文本，最多 200 KB。" },
		tags: {
			type: "array",
			items: { type: "string" },
			description: "可选。标签列表，例如 [\"RNA-seq\", \"流程\"]。",
		},
		visibility: {
			type: "string",
			enum: ["private", "roles", "public"],
			description: "可选。private=仅自己（默认），roles=指定角色，public=全实验室。",
		},
		roles: {
			type: "array",
			items: { type: "string" },
			description: "visibility=roles 时必填，例如 [\"lab-student\"]。",
		},
	},
	required: ["title"],
};

/** lab_plot 参数 */
const PlotParams = {
	type: "object",
	properties: {
		chart: {
			type: "string",
			description:
				"模板 id：bar/line/scatter/box/violin/heatmap/volcano/venn/tree/circos/manhattan/pca/gsea。",
		},
		title: { type: "string", description: "图表标题，留空使用模板名。" },
		data: {
			type: "string",
			description: "CSV/TSV 文本（首行为列名）。tree 模板可省略，改用 params.newick。",
		},
		sample: {
			type: "string",
			description: "可选。使用内置示例数据：sample id（见 lab_plot 返回的模板列表）。",
		},
		params: {
			type: "object",
			description:
				"可选。模板参数，如 {\"x\":\"category\",\"y\":\"value\",\"group\":\"group\",\"palette\":\"npg\"}；颜色可直接传 colors:[\"#000080\",\"#B22222\"]。",
		},
		wait: {
			type: "boolean",
			description: "可选。true（默认）=等待渲染完成并返回输出；false=立即返回任务 id。",
		},
	},
	required: ["chart"],
};

/** lab_plot_jobs 参数 */
const PlotJobsParams = {
	type: "object",
	properties: {
		limit: { type: "number", description: "可选。返回条数上限，默认 10，最大 50。" },
	},
};

/** lab_sandbox_run 参数 */
const SandboxParams = {
	type: "object",
	properties: {
		language: {
			type: "string",
			enum: ["python", "bash"],
			description: "可选。python（默认）或 bash。",
		},
		code: {
			type: "string",
			description: "要执行的代码。沙箱无网络、只读根文件系统、256MB 内存，执行完容器立即销毁。",
		},
		timeout: {
			type: "number",
			description: "可选。超时秒数，默认 20，最大 60。",
		},
	},
	required: ["code"],
};

/** lab_memory_save 参数 */
const MemorySaveParams = {
	type: "object",
	properties: {
		kind: {
			type: "string",
			enum: ["fact", "preference", "lesson", "project", "note"],
			description: "可选。记忆类型：事实/偏好/教训/项目/笔记，默认 fact。",
		},
		title: { type: "string", description: "一句话标题，最多 160 字。" },
		content: { type: "string", description: "完整内容，最多 4000 字。" },
	},
	required: ["content"],
};

/** lab_memory_search 参数 */
const MemorySearchParams = {
	type: "object",
	properties: {
		q: { type: "string", description: "可选。按标题或内容检索；留空返回最近记忆。" },
		kind: {
			type: "string",
			enum: ["fact", "preference", "lesson", "project", "note"],
			description: "可选。按类型过滤。",
		},
		limit: { type: "number", description: "可选。返回条数上限，默认 8，最大 50。" },
	},
};

/** lab_memory_forget 参数 */
const MemoryForgetParams = {
	type: "object",
	properties: {
		id: { type: "string", description: "可选。要删除的记忆 id（优先）。" },
		query: { type: "string", description: "可选。按关键词匹配标题/内容后删除。" },
	},
};

/* ------------------------------------------------------------------ 基础工具函数 */

function getBaseUrl() {
	const raw = (process.env.LAB_PORTAL_URL || "").trim();
	const base = raw || DEFAULT_BASE_URL;
	return base.replace(/\/+$/, "");
}

function getToken() {
	return (process.env.LAB_PORTAL_TOKEN || "").trim();
}

/**
 * 用户自己的会话 JWT（由 pi 网关注入环境变量 LAB_PORTAL_BEARER）。
 * 带上它就能以用户身份访问门户接口（权限与该用户一致），优先于内部服务令牌。
 */
function getBearer() {
	return (process.env.LAB_PORTAL_BEARER || "").trim();
}

function describeNetworkError(err, timeoutMs = REQUEST_TIMEOUT_MS) {
	const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
	if (name === "AbortError" || name === "TimeoutError") {
		return `请求超时（超过 ${timeoutMs / 1000} 秒）`;
	}
	const message = err instanceof Error ? err.message : String(err);
	if (name === "TypeError" || /fetch failed/i.test(message)) {
		return "网络请求失败（地址不可达或连接被拒绝）";
	}
	return message || "未知网络错误";
}

function extractDetail(text) {
	if (!text) return "";
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed.detail === "string") return parsed.detail;
		if (parsed && typeof parsed.error === "string") return parsed.error;
	} catch {
		/* 非 JSON 响应，忽略 */
	}
	return text.slice(0, 300);
}

/**
 * 调用门户内部接口。
 * @returns {Promise<{ok: true, data: any} | {ok: false, error: string}>}
 */
async function portalFetch(path, options = {}) {
	const bearer = getBearer();
	const token = getToken();
	if (!bearer && !token) {
		return {
			ok: false,
			error:
				"未配置 LAB_PORTAL_BEARER 或 LAB_PORTAL_TOKEN，无法调用门户内部接口。" +
				"前者是用户会话 JWT（由网关注入），后者是内部服务令牌（白名单见 docs/CONTRACT_WORKBENCH_AGENT.md §3）。",
		};
	}

	const base = getBaseUrl();
	const url = `${base}${path}`;
	const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : REQUEST_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let response;
	try {
		response = await fetch(url, {
			method: options.method || "GET",
			headers: {
				// 用户会话 JWT（优先）与内部服务令牌（补充）**同时**携带：
				// 用户级接口（工作台、收藏等）认 Authorization，全局接口两者都能用。
				...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
				...(token ? { "X-Lab-Service-Token": token } : {}),
				Accept: "application/json",
				...(options.body ? { "Content-Type": "application/json" } : {}),
			},
			body: options.body ? JSON.stringify(options.body) : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		return { ok: false, error: `无法访问门户服务（${base}）：${describeNetworkError(err, timeoutMs)}` };
	} finally {
		clearTimeout(timer);
	}

	let text = "";
	try {
		text = await response.text();
	} catch (err) {
		return { ok: false, error: `读取门户响应失败：${describeNetworkError(err, timeoutMs)}` };
	}

	if (!response.ok) {
		const detail = extractDetail(text);
		return {
			ok: false,
			error: `门户返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`,
		};
	}

	if (!text.trim()) return { ok: true, data: {} };

	try {
		return { ok: true, data: JSON.parse(text) };
	} catch {
		return { ok: true, data: { raw: text } };
	}
}

function toolResult(text, details, isError = false) {
	return {
		content: [{ type: "text", text }],
		details: details ?? {},
		...(isError ? { isError: true } : {}),
	};
}

/** 调用宿主机一次性沙箱（docker run --rm），返回 stdout/stderr。 */
async function sandboxFetch(payload, timeoutMs = 70000) {
	const token = (process.env.LAB_SANDBOX_TOKEN || "").trim();
	const base = (process.env.LAB_SANDBOX_URL || "http://127.0.0.1:8130").replace(/\/+$/, "");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let response;
	try {
		response = await fetch(`${base}/run`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { "X-Lab-Sandbox-Token": token } : {}),
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
	} catch (err) {
		return { ok: false, error: `无法连接代码沙箱：${describeNetworkError(err, timeoutMs)}` };
	} finally {
		clearTimeout(timer);
	}
	const text = await response.text().catch(() => "");
	if (!response.ok) {
		let detail = "";
		try {
			detail = JSON.parse(text).error || "";
		} catch {
			detail = text.slice(0, 200);
		}
		return { ok: false, error: `沙箱返回 HTTP ${response.status}${detail ? `：${detail}` : ""}` };
	}
	try {
		return { ok: true, data: JSON.parse(text) };
	} catch {
		return { ok: false, error: "沙箱响应不是合法 JSON" };
	}
}

function errorResult(message, details = {}) {
	return toolResult(`错误：${message}`, { ...details, error: message }, true);
}

function truncate(text, max) {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/* ------------------------------------------------------------------ 数据库目录映射 */

let databaseCache = { at: 0, items: [] };

/** 拉取数据库目录（5 分钟内存缓存） */
async function loadDatabaseIndex() {
	const now = Date.now();
	if (databaseCache.items.length > 0 && now - databaseCache.at < DATABASE_CACHE_TTL_MS) {
		return { ok: true, items: databaseCache.items };
	}
	const res = await portalFetch("/api/databases");
	if (!res.ok) return res;
	const items = Array.isArray(res.data?.items) ? res.data.items : [];
	databaseCache = { at: now, items };
	return { ok: true, items };
}

/** 用名称/中文名/id 模糊匹配数据库条目 */
function matchDatabase(items, wanted) {
	const needle = String(wanted || "").trim().toLowerCase();
	if (!needle) return null;

	const scored = [];
	for (const item of items) {
		const id = String(item.id || "").toLowerCase();
		const name = String(item.name || "").toLowerCase();
		const cn = String(item.cn || "").toLowerCase();
		const desc = String(item.desc || item.description || "").toLowerCase();
		const category = String(item.category || "").toLowerCase();

		let score = 0;
		if (id === needle) score = 100;
		else if (name === needle) score = 95;
		else if (cn === needle) score = 95;
		else if (name.startsWith(needle) || cn.startsWith(needle)) score = 80;
		else if (name.includes(needle) || cn.includes(needle) || id.includes(needle)) score = 70;
		else if (desc.includes(needle) || category.includes(needle)) score = 40;

		// 多词检索（模型常写成 “NCBI GenBank”“KEGG 数据库” 这类）：
		// 逐个词元匹配，命中 id / 名称 / 中文名的词元给高分，避免明明有库却匹配不到。
		if (score < 70) {
			const tokens = needle
				.split(/[\s,，、/（）()「」【】]+/)
				.map((t) => t.trim())
				.filter((t) => t.length >= 2 && t !== "数据库" && t !== "数据库目录");
			for (const token of tokens) {
				if (id === token || id.includes(token)) { score = Math.max(score, 90); break; }
				if (name.toLowerCase().includes(token)) { score = Math.max(score, 85); break; }
				if (cn.toLowerCase().includes(token)) { score = Math.max(score, 85); break; }
				if (desc.includes(token) || category.includes(token)) score = Math.max(score, 45);
			}
		}

		if (score > 0) scored.push({ item, score });
	}

	if (scored.length === 0) return null;
	scored.sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name)));
	return scored[0].item;
}

/* ------------------------------------------------------------------ 扩展入口 */

export default function labPortalExtension(pi) {
	/* -------- lab_services -------- */
	pi.registerTool({
		name: "lab_services",
		label: "实验室服务",
		description:
			"查询实验室门户登记的内网服务清单（名称、URL、说明）。" +
			"用于回答“有哪些内网服务”“XX 服务的地址是什么”之类的问题。" +
			"可选参数 q 会在本地按名称/说明/分类/URL 过滤。" +
			"例：lab_services({ q: \"搜索\" })",
		promptSnippet: "查询实验室门户登记的内网服务清单",
		parameters: ServicesParams,
		async execute(_toolCallId, params) {
			const q = typeof params?.q === "string" ? params.q.trim() : "";
			const res = await portalFetch("/api/services");
			if (!res.ok) return errorResult(res.error, { tool: "lab_services" });

			const all = Array.isArray(res.data?.services) ? res.data.services : [];
			const needle = q.toLowerCase();
			const services = needle
				? all.filter((svc) =>
						`${svc?.name ?? ""} ${svc?.description ?? ""} ${svc?.category ?? ""} ${svc?.url ?? ""} ${svc?.id ?? ""}`
							.toLowerCase()
							.includes(needle),
					)
				: all;

			if (services.length === 0) {
				const suffix = q ? `（关键词：${q}）` : "";
				return toolResult(`未找到内网服务${suffix}。门户当前共登记 ${all.length} 个服务。`, {
					tool: "lab_services",
					query: q,
					count: 0,
				});
			}

			const lines = services.map((svc, index) => {
				const name = svc?.name || svc?.id || "(未命名)";
				const url = svc?.url || "";
				const desc = truncate(svc?.description || "", 160);
				return `${index + 1}. ${name}${svc?.category ? ` [${svc.category}]` : ""}` +
					`${desc ? ` — ${desc}` : ""}${url ? `\n   URL: ${url}` : ""}`;
			});

			const header = q
				? `匹配「${q}」的内网服务共 ${services.length} 个（门户共 ${all.length} 个）：`
				: `门户登记的内网服务共 ${services.length} 个：`;

			return toolResult(`${header}\n${lines.join("\n")}`, {
				tool: "lab_services",
				query: q,
				count: services.length,
				services,
			});
		},
	});

	/* -------- lab_database_query -------- */
	pi.registerTool({
		name: "lab_database_query",
		label: "数据库查询",
		description:
			"在实验室门户登记的植物/生物数据库中执行一次真实检索（后端代理公开 API），返回归一化结果（标题、链接、来源字段）。" +
			"database 可填数据库中文名、英文名或 id，支持模糊匹配；limit 默认 5、最大 20。" +
			"例：lab_database_query({ database: \"NCBI\", query: \"Arabidopsis thaliana\", limit: 5 })",
		promptSnippet: "查询实验室门户登记的数据库（需指定数据库名与检索词）",
		parameters: DatabaseQueryParams,
		async execute(_toolCallId, params) {
			const database = typeof params?.database === "string" ? params.database.trim() : "";
			const query = typeof params?.query === "string" ? params.query.trim() : "";
			if (!database) return errorResult("参数 database 不能为空，请提供数据库名称或 id。", { tool: "lab_database_query" });
			if (!query) return errorResult("参数 query 不能为空，请提供检索关键词。", { tool: "lab_database_query" });

			const index = await loadDatabaseIndex();
			if (!index.ok) return errorResult(index.error, { tool: "lab_database_query" });

			const matched = matchDatabase(index.items, database);
			if (!matched) {
				const names = index.items.slice(0, 20).map((item) => item.cn || item.name || item.id).join("、");
				return errorResult(
					`未在门户数据库目录中找到「${database}」。可用的数据库示例：${names}${index.items.length > 20 ? " …" : ""}`,
					{ tool: "lab_database_query", database },
				);
			}

			const limit = Math.max(1, Math.min(Number(params?.limit) || DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));
			const res = await portalFetch(`/api/databases/${encodeURIComponent(matched.id)}/query`, {
				method: "POST",
				body: { query, limit },
			});
			if (!res.ok) return errorResult(res.error, { tool: "lab_database_query", database: matched.id });

			const data = res.data || {};
			const items = Array.isArray(data.items) ? data.items : [];
			const sourceName = matched.cn || matched.name || matched.id;

			if (data.ok === false || (items.length === 0 && data.error)) {
				const reason = typeof data.error === "string" ? data.error : "该数据库没有返回可用结果";
				return errorResult(`查询「${sourceName}」失败：${reason}`, {
					tool: "lab_database_query",
					database: matched.id,
					query,
				});
			}

			if (items.length === 0) {
				return toolResult(`数据库「${sourceName}」没有匹配「${query}」的结果。`, {
					tool: "lab_database_query",
					database: matched.id,
					query,
					count: 0,
				});
			}

			const lines = items.map((item, i) => {
				const fields = Array.isArray(item?.fields)
					? item.fields.map((f) => `${f.label}: ${f.value}`).join("; ")
					: "";
				return `${i + 1}. ${item?.title || "(无标题)"}${item?.subtitle ? ` — ${item.subtitle}` : ""}` +
					`${item?.url ? `\n   URL: ${item.url}` : ""}${fields ? `\n   ${fields}` : ""}`;
			});

			const header = `数据库「${sourceName}」(id=${matched.id}) 中「${query}」的检索结果，共 ${items.length} 条` +
				`${typeof data.elapsedMs === "number" ? `（耗时 ${data.elapsedMs}ms）` : ""}：`;

			return toolResult(`${header}\n${lines.join("\n")}`, {
				tool: "lab_database_query",
				database: matched.id,
				databaseName: sourceName,
				query,
				count: items.length,
				items,
			});
		},
	});

	/* -------- lab_web_search -------- */
	pi.registerTool({
		name: "lab_web_search",
		label: "联网搜索",
		description:
			"通过实验室门户的统一检索接口做联网搜索（scope=web），返回前 8 条结果的标题、链接与摘要。" +
			"适合查文献、工具、数据源等外部资料。例：lab_web_search({ query: \"SearXNG 聚合搜索\" })",
		promptSnippet: "通过门户统一检索接口联网搜索，返回前 8 条结果",
		parameters: WebSearchParams,
		async execute(_toolCallId, params) {
			const query = typeof params?.query === "string" ? params.query.trim() : "";
			if (!query) return errorResult("参数 query 不能为空，请提供搜索关键词。", { tool: "lab_web_search" });

			const res = await portalFetch(`/api/search?scope=web&q=${encodeURIComponent(query)}`);
			if (!res.ok) return errorResult(res.error, { tool: "lab_web_search", query });

			const data = res.data || {};
			const results = Array.isArray(data.results) ? data.results.slice(0, SEARCH_RESULT_LIMIT) : [];

			if (results.length === 0) {
				return toolResult(`联网搜索「${query}」没有返回结果。`, {
					tool: "lab_web_search",
					query,
					count: 0,
				});
			}

			const lines = results.map((item, i) => {
				const title = item?.title || "(无标题)";
				const url = item?.url || "";
				const summary = truncate(item?.content || item?.snippet || "", 200);
				return `${i + 1}. ${title}${url ? `\n   URL: ${url}` : ""}${summary ? `\n   ${summary}` : ""}`;
			});

			return toolResult(`联网搜索「${query}」的前 ${results.length} 条结果：\n${lines.join("\n")}`, {
				tool: "lab_web_search",
				query,
				count: results.length,
				results,
			});
		},
	});

	/* -------- lab_workbench_capture -------- */
	pi.registerTool({
		name: "lab_workbench_capture",
		label: "工作台捕获",
		description:
			"把用户的一句话记入个人工作台（智能捕获）：后端按本地规则判定条目类型（task/project/idea/knowledge/note/memory/plan）、" +
			"抽取截止日期、#标签与优先级，并返回条目摘要与分类结果。" +
			"例：lab_workbench_capture({ text: \"明天下午前完成蛋白提取 #实验 紧急\" })",
		promptSnippet: "把一句话记入个人工作台，并返回分类结果",
		parameters: WorkbenchCaptureParams,
		async execute(_toolCallId, params) {
			const text = typeof params?.text === "string" ? params.text.trim() : "";
			if (!text) return errorResult("参数 text 不能为空，请提供要记录的内容。", { tool: "lab_workbench_capture" });

			const res = await portalFetch("/api/workbench/capture", { method: "POST", body: { text } });
			if (!res.ok) return errorResult(res.error, { tool: "lab_workbench_capture" });

			const data = res.data || {};
			const item = data.item || null;
			const aiClass = data.ai_class || item?.kind || "unknown";
			const aiReason = data.ai_reason || "";
			const confidence = typeof data.confidence === "number" ? data.confidence : null;
			const extracted = data.extracted || {};

			const lines = [
				`已记入工作台。`,
				`条目：${item?.title || "(无标题)"}`,
				item?.kind ? `类型：${item.kind}` : "",
				item?.status ? `状态：${item.status}` : "",
				item?.priority ? `优先级：${item.priority}` : "",
				item?.due_date ? `截止日期：${item.due_date}` : "",
				Array.isArray(item?.tags) && item.tags.length ? `标签：${item.tags.join("、")}` : "",
				`分类结果：${aiClass}${aiReason ? `（依据：${aiReason}）` : ""}` +
					`${confidence !== null ? `，置信度 ${confidence}` : ""}`,
				extracted?.due_date ? `抽取截止日期：${extracted.due_date}` : "",
				Array.isArray(extracted?.tags) && extracted.tags.length ? `抽取标签：${extracted.tags.join("、")}` : "",
			].filter(Boolean);

			return toolResult(lines.join("\n"), {
				tool: "lab_workbench_capture",
				item,
				ai_class: aiClass,
				ai_reason: aiReason,
				confidence,
				extracted,
			});
		},
	});

	/* -------- lab_knowledge_search -------- */
	pi.registerTool({
		name: "lab_knowledge_search",
		label: "知识库检索",
		description:
			"检索当前用户有权访问的实验室知识库条目（标题、摘要、标签、可见范围）。" +
			"用于复用已有实验笔记、流程和经验。例：lab_knowledge_search({ q: \"RNA-seq 质控\" })",
		promptSnippet: "检索实验室知识库，复用已有笔记与经验",
		parameters: KnowledgeSearchParams,
		async execute(_toolCallId, params) {
			const q = typeof params?.q === "string" ? params.q.trim() : "";
			const limit = Math.max(1, Math.min(Number(params?.limit) || 10, 50));
			const search = new URLSearchParams({ limit: String(limit) });
			if (q) search.set("q", q);
			const res = await portalFetch(`/api/knowledge?${search.toString()}`);
			if (!res.ok) return errorResult(res.error, { tool: "lab_knowledge_search", query: q });

			const items = Array.isArray(res.data?.items) ? res.data.items : [];
			if (items.length === 0) {
				return toolResult(q ? `知识库中没有匹配「${q}」的条目。` : "知识库当前没有条目。", {
					tool: "lab_knowledge_search",
					query: q,
					count: 0,
				});
			}
			const lines = items.map((item, i) => {
				const tags = Array.isArray(item?.tags) && item.tags.length ? ` [${item.tags.join("、")}]` : "";
				return `${i + 1}. ${item?.title || "(无标题)"}（${item?.visibility || "private"}）${tags}\n   ${truncate(item?.excerpt || "", 180)}`;
			});
			return toolResult(`知识库命中 ${items.length} 条${q ? `（关键词：${q}）` : ""}：\n${lines.join("\n")}`, {
				tool: "lab_knowledge_search",
				query: q,
				count: items.length,
				items,
			});
		},
	});

	/* -------- lab_knowledge_save -------- */
	pi.registerTool({
		name: "lab_knowledge_save",
		label: "知识入库",
		description:
			"把整理好的结论、实验流程或踩坑经验保存到当前用户的实验室知识库（默认仅自己可见）。" +
			"只在用户明确要求沉淀/保存时调用，不要自动保存聊天内容。" +
			"例：lab_knowledge_save({ title: \"RNA-seq 质控流程\", body: \"...\", tags: [\"RNA-seq\"] })",
		promptSnippet: "将用户确认的经验或结论保存到实验室知识库",
		parameters: KnowledgeSaveParams,
		async execute(_toolCallId, params) {
			const title = typeof params?.title === "string" ? params.title.trim() : "";
			if (!title) return errorResult("参数 title 不能为空。", { tool: "lab_knowledge_save" });
			const visibility = ["private", "roles", "public"].includes(params?.visibility)
				? params.visibility
				: "private";
			const roles = visibility === "roles" && Array.isArray(params?.roles) ? params.roles : [];
			if (visibility === "roles" && roles.length === 0) {
				return errorResult("visibility=roles 时必须提供至少一个角色组。", { tool: "lab_knowledge_save" });
			}
			const body = {
				title,
				body: typeof params?.body === "string" ? params.body : "",
				tags: Array.isArray(params?.tags) ? params.tags : [],
				visibility,
				roles,
			};
			const res = await portalFetch("/api/knowledge", { method: "POST", body });
			if (!res.ok) return errorResult(res.error, { tool: "lab_knowledge_save", title });
			const item = res.data?.item || null;
			return toolResult(`已保存到知识库：${item?.title || title}（id=${item?.id ?? "?"}，${item?.visibility || visibility}）`, {
				tool: "lab_knowledge_save",
				item,
			});
		},
	});

	/* -------- lab_workbench_list -------- */
	pi.registerTool({
		name: "lab_workbench_list",
		label: "工作台条目",
		description:
			"列出当前用户的个人工作台条目（任务/项目/想法/知识/笔记/记忆/计划），可按 kind 过滤，limit 默认 20、最大 200。" +
			"例：lab_workbench_list({ kind: \"task\", limit: 10 })",
		promptSnippet: "列出个人工作台条目（可按类型过滤）",
		parameters: WorkbenchListParams,
		async execute(_toolCallId, params) {
			const kind = typeof params?.kind === "string" ? params.kind.trim() : "";
			const limit = Math.max(1, Math.min(Number(params?.limit) || 20, 200));

			const search = new URLSearchParams();
			if (kind) search.set("kind", kind);
			search.set("limit", String(limit));
			const suffix = search.toString() ? `?${search.toString()}` : "";

			const res = await portalFetch(`/api/workbench/items${suffix}`);
			if (!res.ok) return errorResult(res.error, { tool: "lab_workbench_list", kind });

			const data = res.data || {};
			const items = Array.isArray(data.items) ? data.items : [];
			if (items.length === 0) {
				return toolResult(`工作台中${kind ? `类型为 ${kind} 的` : ""}条目为空。`, {
					tool: "lab_workbench_list",
					kind,
					count: 0,
				});
			}

			const lines = items.map((item, i) => {
				const tags = Array.isArray(item?.tags) && item.tags.length ? ` [${item.tags.join("、")}]` : "";
				const due = item?.due_date ? `，截止 ${item.due_date}` : "";
				const priority = item?.priority && item.priority !== "normal" ? `，优先级 ${item.priority}` : "";
				return `${i + 1}. ${item?.title || "(无标题)"}（${item?.kind || "?"}/${item?.status || "?"}${priority}${due}）${tags}` +
					`${item?.content ? `\n   ${truncate(item.content, 160)}` : ""}`;
			});

			const total = typeof data.total === "number" ? data.total : items.length;
			return toolResult(`工作台条目共 ${total} 条${kind ? `（类型 ${kind}）` : ""}，以下显示 ${items.length} 条：\n${lines.join("\n")}`, {
				tool: "lab_workbench_list",
				kind,
				count: items.length,
				total,
				items,
			});
		},
	});

	/* -------- lab_plot -------- */
	pi.registerTool({
		name: "lab_plot",
		label: "代码绘图",
		description:
			"以当前用户身份提交一次出版级图表渲染（Go 队列 + Python seaborn/ete3/pyCircos/GSEApy 等），返回 PNG/SVG/PDF 下载链接。" +
			"chart 可选 bar/line/scatter/box/violin/heatmap/volcano/venn/tree/circos/manhattan/pca/gsea；" +
			"data 为 CSV 文本，也可用 sample 指定内置示例。默认等待渲染完成。" +
			"例：lab_plot({ chart: \"volcano\", data: \"gene,log2fc,padj\\nA,2.1,0.001\\nB,-1.8,0.01\" })",
		promptSnippet: "按当前用户提交 seaborn/生信图表渲染并取回成品链接",
		parameters: PlotParams,
		async execute(_toolCallId, params) {
			const chart = typeof params?.chart === "string" ? params.chart.trim() : "";
			if (!chart) return errorResult("参数 chart 不能为空。", { tool: "lab_plot" });
			const body = {
				chart,
				title: typeof params?.title === "string" ? params.title : "",
				data: typeof params?.data === "string" ? params.data : "",
				sample: typeof params?.sample === "string" ? params.sample : "",
				params: params?.params && typeof params.params === "object" ? params.params : {},
				wait: params?.wait !== false,
			};
			const timeoutMs = body.wait ? 75000 : REQUEST_TIMEOUT_MS;
			const res = await portalFetch("/api/next/v1/plot/jobs", { method: "POST", body, timeoutMs });
			if (!res.ok) return errorResult(res.error, { tool: "lab_plot", chart });

			const job = res.data || {};
			const outputs = Array.isArray(job.outputs) ? job.outputs : [];
			const base = getBaseUrl();
			const files = outputs.map((o) => {
				const url = `${base}/api/next/v1/plot/jobs/${encodeURIComponent(job.id)}/file?path=${encodeURIComponent(o.path)}`;
				const kb = typeof o.size === "number" ? ` ${(o.size / 1024).toFixed(1)} KB` : "";
				return `- ${o.path}${kb}\n  ${url}`;
			});
			const summary = `绘图任务 ${job.id || "?"}（${chart}）状态：${job.status || "queued"}${job.message ? `，${job.message}` : ""}`;
			const text = files.length ? `${summary}\n成品：\n${files.join("\n")}` : summary;
			return toolResult(text, {
				tool: "lab_plot",
				chart,
				job_id: job.id,
				status: job.status,
				outputs,
				files: files.map((line, i) => ({
					path: outputs[i]?.path,
					url: `${base}/api/next/v1/plot/jobs/${encodeURIComponent(job.id)}/file?path=${encodeURIComponent(outputs[i]?.path || "")}`,
				})),
			}, job.status === "failed");
		},
	});

	/* -------- lab_plot_jobs -------- */
	pi.registerTool({
		name: "lab_plot_jobs",
		label: "绘图历史",
		description:
			"列出当前用户最近的绘图任务与成品状态，便于复用或下载。例：lab_plot_jobs({ limit: 10 })",
		promptSnippet: "列出当前用户的绘图任务历史",
		parameters: PlotJobsParams,
		async execute(_toolCallId, params) {
			const limit = Math.max(1, Math.min(Number(params?.limit) || 10, 50));
			const res = await portalFetch(`/api/next/v1/plot/jobs?limit=${limit}`);
			if (!res.ok) return errorResult(res.error, { tool: "lab_plot_jobs" });
			const items = Array.isArray(res.data?.items) ? res.data.items : [];
			if (items.length === 0) return toolResult("还没有绘图任务。", { tool: "lab_plot_jobs", count: 0 });
			const lines = items.map((j, i) => {
				const outs = Array.isArray(j.outputs) ? j.outputs.map((o) => o.path).join(", ") : "";
				return `${i + 1}. ${j.title || j.id}（${j.chart}，${j.status}）${outs ? `\n   ${outs}` : ""}`;
			});
			return toolResult(`最近 ${items.length} 个绘图任务：\n${lines.join("\n")}`, {
				tool: "lab_plot_jobs",
				count: items.length,
				items,
			});
		},
	});

	/* -------- lab_sandbox_run -------- */
	pi.registerTool({
		name: "lab_sandbox_run",
		label: "代码沙箱",
		description:
			"在一次性安全沙箱中执行 Python 或 bash 代码：无网络、只读根文件系统、256MB 内存、CPU 0.5 核，" +
			"默认 20 秒超时，执行结束容器立即销毁。适合数值计算、数据处理、格式转换与快速验证。" +
			"例：lab_sandbox_run({ language: \"python\", code: \"print(sum(range(10)))\" })",
		promptSnippet: "在一次性容器沙箱中执行 Python/bash 代码并取回输出",
		parameters: SandboxParams,
		async execute(_toolCallId, params) {
			const code = typeof params?.code === "string" ? params.code : "";
			if (!code.trim()) return errorResult("参数 code 不能为空。", { tool: "lab_sandbox_run" });
			const language = params?.language === "bash" ? "bash" : "python";
			const timeout = Math.max(1, Math.min(Number(params?.timeout) || 20, 60));
			const res = await sandboxFetch({ language, code, timeout }, (timeout + 20) * 1000);
			if (!res.ok) return errorResult(res.error, { tool: "lab_sandbox_run", language });
			const data = res.data || {};
			const parts = [
				`沙箱执行${data.ok ? "成功" : "失败"}（${language}，退出码 ${data.exitCode}，${data.elapsedMs}ms，容器已销毁）`,
			];
			if (data.stdout) parts.push(`stdout:\n${data.stdout}`);
			if (data.stderr) parts.push(`stderr:\n${data.stderr}`);
			return toolResult(parts.join("\n\n"), { tool: "lab_sandbox_run", language, ...data }, !data.ok);
		},
	});

	/* -------- lab_memory_search -------- */
	pi.registerTool({
		name: "lab_memory_search",
		label: "检索长期记忆",
		description:
			"检索当前用户的私有长期记忆（事实、偏好、经验教训、项目背景）。开始一项需要历史上下文的科研任务时先调用。" +
			"例：lab_memory_search({ q: \"RNA-seq 流程\" })",
		promptSnippet: "检索当前用户的私有长期记忆",
		parameters: MemorySearchParams,
		async execute(_toolCallId, params) {
			const q = typeof params?.q === "string" ? params.q.trim() : "";
			const kind = typeof params?.kind === "string" ? params.kind.trim() : "";
			const limit = Math.max(1, Math.min(Number(params?.limit) || 8, 50));
			const query = new URLSearchParams({ limit: String(limit) });
			if (q) query.set("q", q);
			if (kind) query.set("kind", kind);
			const res = await portalFetch(`/api/agent/memories?${query.toString()}`);
			if (!res.ok) return errorResult(res.error, { tool: "lab_memory_search" });
			const items = Array.isArray(res.data?.memories) ? res.data.memories : [];
			if (items.length === 0) {
				return toolResult(q ? `没有找到与「${q}」相关的长期记忆。` : "还没有长期记忆。", {
					tool: "lab_memory_search",
					count: 0,
				});
			}
			const lines = items.map(
				(m, i) => `${i + 1}. [${m.kind}] ${m.title}${m.pinned ? "（置顶）" : ""}\n   ${truncate(m.content, 300)}`,
			);
			return toolResult(`找到 ${items.length} 条长期记忆：\n${lines.join("\n")}`, {
				tool: "lab_memory_search",
				count: items.length,
				memories: items,
			});
		},
	});

	/* -------- lab_memory_save -------- */
	pi.registerTool({
		name: "lab_memory_save",
		label: "写入长期记忆",
		description:
			"把值得跨会话保留的事实、用户偏好、方法学经验或项目背景写入当前用户的私有长期记忆。" +
			"例：lab_memory_save({ kind: \"preference\", title: \"图表配色\", content: \"偏好 Nature 配色，图宽 120mm\" })",
		promptSnippet: "把重要结论或用户偏好写入私有长期记忆",
		parameters: MemorySaveParams,
		async execute(_toolCallId, params) {
			const content = typeof params?.content === "string" ? params.content.trim() : "";
			if (!content) return errorResult("参数 content 不能为空。", { tool: "lab_memory_save" });
			const res = await portalFetch("/api/agent/memories", {
				method: "POST",
				body: {
					kind: typeof params?.kind === "string" ? params.kind : "fact",
					title: typeof params?.title === "string" ? params.title : "",
					content,
				},
			});
			if (!res.ok) return errorResult(res.error, { tool: "lab_memory_save" });
			const memory = res.data?.memory || {};
			return toolResult(`已写入长期记忆：${memory.title || content.slice(0, 40)}`, {
				tool: "lab_memory_save",
				memory,
				deduped: Boolean(res.data?.deduped),
			});
		},
	});

	/* -------- lab_memory_forget -------- */
	pi.registerTool({
		name: "lab_memory_forget",
		label: "删除长期记忆",
		description:
			"删除当前用户的长期记忆：优先按 id，否则按关键词匹配标题/内容。用户明确要求忘记某事时使用。" +
			"例：lab_memory_forget({ query: \"旧配色\" })",
		promptSnippet: "删除当前用户的长期记忆",
		parameters: MemoryForgetParams,
		async execute(_toolCallId, params) {
			const id = typeof params?.id === "string" ? params.id.trim() : "";
			const q = typeof params?.query === "string" ? params.query.trim() : "";
			if (!id && !q) return errorResult("请提供 id 或 query。", { tool: "lab_memory_forget" });
			if (id) {
				const res = await portalFetch(`/api/agent/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
				if (!res.ok) return errorResult(res.error, { tool: "lab_memory_forget" });
				return toolResult(`已删除记忆 ${id}。`, { tool: "lab_memory_forget", id });
			}
			const found = await portalFetch(`/api/agent/memories?q=${encodeURIComponent(q)}&limit=20`);
			if (!found.ok) return errorResult(found.error, { tool: "lab_memory_forget" });
			const items = Array.isArray(found.data?.memories) ? found.data.memories : [];
			if (items.length === 0) return toolResult(`没有找到与「${q}」匹配的记忆。`, { tool: "lab_memory_forget", count: 0 });
			for (const item of items) {
				await portalFetch(`/api/agent/memories/${encodeURIComponent(item.id)}`, { method: "DELETE" });
			}
			return toolResult(`已删除 ${items.length} 条匹配「${q}」的记忆。`, {
				tool: "lab_memory_forget",
				count: items.length,
				ids: items.map((m) => m.id),
			});
		},
	});
}
