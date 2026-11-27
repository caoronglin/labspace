import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Masonry,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Input,
  Popover,
  Row,
  Skeleton,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  BookOutlined,
  ClockCircleOutlined,
  CloudServerOutlined,
  CodeOutlined,
  ConsoleSqlOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FilePdfOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  NotificationOutlined,
  PartitionOutlined,
  ProfileOutlined,
  RobotOutlined,
  ScanOutlined,
  ScheduleOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { api, type ServiceItem } from "../services/api";
import AcademicSearch from "../components/AcademicSearch";
import PlantDatabasePanel from "../components/PlantDatabasePanel";
import { CATEGORY_LABEL } from "../components/ServiceCard";
import { serviceTarget } from "../utils/serviceRoute";
import { useAuth } from "../app/AuthContext";
import { tokens } from '../theme/tokens';
import { palette } from '../theme/palette';

/* ------------------------------------------------------------ 常量 */

/** WMO 天气代码 → 图标，用于 Hero 标题旁的今日天气胶囊。 */
function weatherGlyph(code: number | null | undefined): string {
  if (code == null) return "🌡️";
  if (code === 0) return "☀️";
  if (code === 1) return "🌤️";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌤️";
}

const SERVICE_ICONS: Record<string, ReactNode> = {
  RobotOutlined: <RobotOutlined />,
  FolderOpenOutlined: <FolderOpenOutlined />,
  PartitionOutlined: <PartitionOutlined />,
  ConsoleSqlOutlined: <ConsoleSqlOutlined />,
  ToolOutlined: <ToolOutlined />,
  BookOutlined: <BookOutlined />,
  FilePdfOutlined: <FilePdfOutlined />,
  FileSearchOutlined: <FileSearchOutlined />,
  GlobalOutlined: <GlobalOutlined />,
  CodeOutlined: <CodeOutlined />,
  AppstoreOutlined: <AppstoreOutlined />,
  CloudServerOutlined: <CloudServerOutlined />,
  ScanOutlined: <ScanOutlined />,
  DatabaseOutlined: <DatabaseOutlined />,
};

const CATEGORY_ACCENT: Record<string, string> = {
  ai: tokens.colorPrimary,
  files: tokens.colorAccent,
  research: palette.brand.cyan700,
  learn: tokens.colorWarning,
  draw: palette.brand.orange700,
  dev: tokens.colorPrimary,
};

/** 首页优先展示的常用服务（按 id），其余服务自动补位 */
const PINNED = [
  "bioinfo-training",
  "drawio",
  "linux-command",
  "literature-search",
  "jbrowse",
];
const HOME_SERVICE_COUNT = 12;

/**
 * 首页快捷入口：只放**每天真会用到**的八个。
 *
 * 之前是九个“功能罗列”（含天气、起始页这种浏览器级别的跳转），点开之后
 * 还得再找一次；现在按“今天要干什么”排：找人/找资料 → 存东西 → 开会 → 写作。
 */
const QUICK_ENTRIES = [
  {
    key: "ssh",
    label: "SSH 工作台",
    desc: "内网终端 · SFTP 目录",
    icon: <CodeOutlined />,
    path: "/ssh",
    color: tokens.colorPrimary,
  },
  {
    key: "agent",
    label: "AI 助手",
    desc: "对话 · 检索 · 技能",
    icon: <RobotOutlined />,
    path: "/agent",
    color: tokens.colorPrimary,
  },
  {
    key: "files",
    label: "文件空间",
    desc: "个人 · 共享 · 公共",
    icon: <FolderOpenOutlined />,
    path: "/files",
    color: tokens.colorAccent,
  },
  {
    key: "research",
    label: "课题资料",
    desc: "进组时间-姓名 · 个人目录",
    icon: <ProfileOutlined />,
    path: "/research",
    color: palette.brand.violet600,
  },
  {
    key: "meetings",
    label: "组会汇报",
    desc: "按周归档 · 逐周授权",
    icon: <ScheduleOutlined />,
    path: "/meetings",
    color: palette.brand.cyan700,
  },
  {
    key: "seeds",
    label: "种子管理",
    desc: "入库 · 存放 · 备份台账",
    icon: <ExperimentOutlined />,
    path: "/seeds",
    color: tokens.colorSuccess,
  },
  {
    key: "literature",
    label: "文献检索",
    desc: "统一检索 · 每日论文",
    icon: <BookOutlined />,
    path: "/literature",
    color: tokens.colorPrimary,
  },
  {
    key: "latex",
    label: "LaTeX 写作",
    desc: "选刊 · 撰写 · 编译",
    icon: <FileTextOutlined />,
    path: "/latex",
    color: tokens.colorWarning,
  },
  {
    key: "commands",
    label: "命令速查",
    desc: "Linux 命令速查表",
    icon: <ConsoleSqlOutlined />,
    path: "/commands",
    color: tokens.colorAccent,
  },
  {
    key: "pdf",
    label: "PDF 工具箱",
    desc: "合并 · 拆分 · 压缩",
    icon: <FilePdfOutlined />,
    path: "/pdf",
    color: palette.brand.orange700,
  },
];

/**
 * 已经在快捷入口里出现过的服务 id。
 *
 * 首页原来有「8 个快捷入口」+「12 张常用服务卡」两套入口，语义高度重叠
 * （文献检索、命令速查两边都有），用户要判断"哪个才是入口"，一屏的信息
 * 密度也翻倍。处理办法：**同��个服务只出现一次** —— 出现在快捷入口的
 * 就不再占常用服务的位置，常用服务里的空位由其它服务自动补上。
 */
const SERVICES_ALREADY_IN_QUICK = new Set(['literature-search', 'linux-command']);

/* ------------------------------------------------------------ 小组件 */

/** Bing 每日图 → Hero 磨砂背景，并从图片中提取主色驱动强调色。 */
function useHeroBackdrop(): CSSProperties {
  const [vars, setVars] = useState<Record<string, string>>({});
  useEffect(() => {
    const img = new Image();
    img.decoding = "async";
    img.src = "/api/background/daily";
    img.onload = () => {
      // 显式 string：下面会赋 hsl() 模板串，不能让它锁成字面量类型
      let accent: string = palette.brand.blue200;
      let scrim = 0.58;
      try {
        const size = 32;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, size, size);
          const { data } = ctx.getImageData(0, 0, size, size);
          const hueWeight = new Array<number>(36).fill(0);
          let lum = 0;
          let n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            lum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            n += 1;
            const mx = Math.max(r, g, b);
            const d = mx - Math.min(r, g, b);
            if (d > 20 && mx > 32) {
              let h = 0;
              if (mx === r) h = ((g - b) / d + 6) % 6;
              else if (mx === g) h = (b - r) / d + 2;
              else h = (r - g) / d + 4;
              hueWeight[Math.floor(((h * 60) % 360) / 10) % 36] +=
                (d / 255) * (0.35 + (mx / 255) * 0.65);
            }
          }
          if (n > 0) {
            // 亮图需要更重的压暗层，暗图保留更多画面细节
            scrim = Math.min(0.74, Math.max(0.36, 0.8 - (lum / n) * 0.55));
          }
          let best = -1;
          let bestWeight = 0;
          for (let i = 0; i < hueWeight.length; i += 1) {
            if (hueWeight[i] > bestWeight) {
              bestWeight = hueWeight[i];
              best = i;
            }
          }
          if (best >= 0) {
            const hue = best * 10 + 5;
            accent = `hsl(${hue}, 90%, 74%)`;
            setVars({
              "--hero-accent": accent,
              "--hero-accent-soft": `hsla(${hue}, 90%, 70%, 0.2)`,
              "--hero-scrim": scrim.toFixed(2),
            });
            return;
          }
        }
      } catch {
        /* 取色失败时保留默认强调色，不影响背景图展示 */
      }
      setVars({ "--hero-accent": accent, "--hero-scrim": scrim.toFixed(2) });
    };
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, []);
  return vars as CSSProperties;
}

function Metric({
  label,
  value,
  suffix,
  accent,
}: {
  label: string;
  value: number;
  suffix?: string;
  accent: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <Flex align="baseline" gap={4}>
        <span
          style={{
            fontSize: 22,
            fontWeight: 700,
            lineHeight: 1.15,
            color: accent,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
        {suffix ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {suffix}
          </Typography.Text>
        ) : null}
      </Flex>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
    </div>
  );
}

function serviceDotClass(status?: string): string {
  if (status === "up") return "d509-dot d509-dot-up d509-pulse";
  if (status === "down") return "d509-dot d509-dot-down";
  return "d509-dot d509-dot-unknown";
}

function serviceHealthText(status?: string): string {
  if (status === "up") return "服务正常";
  if (status === "down") return "服务不可用";
  return "状态未知";
}

/** 首页服务卡：两行名称截断 + 分类 Tag + 状态点，悬停上浮 2px */
function ServiceTile({
  service,
  favorited,
  onToggleFavorite,
}: {
  service: ServiceItem;
  favorited: boolean;
  onToggleFavorite: (id: string) => void;
}) {
  const navigate = useNavigate();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState(false);
  const status = service.health?.status;
  const accent = CATEGORY_ACCENT[service.category] ?? tokens.colorPrimary;
  const dotClass = serviceDotClass(status);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onEnter = () => setHover(true);
    const onLeave = () => setHover(false);
    card.addEventListener("mouseenter", onEnter);
    card.addEventListener("mouseleave", onLeave);
    return () => {
      card.removeEventListener("mouseenter", onEnter);
      card.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div
      ref={cardRef}
      className="lab-service-card"
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 14,
        transform: hover ? "translateY(-2px)" : "none",
        transition:
          "transform 0.22s cubic-bezier(0.22, 0.61, 0.36, 1), box-shadow 0.22s ease, border-color 0.22s ease",
        boxShadow: hover ? "0 10px 26px rgba(16, 24, 40, 0.09)" : "none",
        border: "1px solid var(--ant-color-border-secondary)",
        background: "var(--ant-color-bg-container, #fff)",
        height: "100%",
        minHeight: 104,
        cursor: "pointer",
      }}
    >
      <button
        type="button"
        aria-label={`打开${service.name}`}
        onClick={() => {
          void api.touchRecent(service.id);
          navigate(serviceTarget(service));
        }}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          border: 0,
          background: "transparent",
          cursor: "pointer",
        }}
      />
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: accent,
          opacity: hover ? 1 : 0.65,
          transition: "opacity 0.2s ease",
        }}
      />
      <div style={{ padding: "14px 14px 12px 17px", position: "relative", zIndex: 2, pointerEvents: "none" }}>
        <Flex gap={10} align="flex-start">
          <span
            className="d509-icon"
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              fontSize: 16,
              background: `${accent}14`,
              color: accent,
            }}
          >
            {SERVICE_ICONS[service.icon] ?? <AppstoreOutlined />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Flex align="center" justify="space-between" gap={8}>
              <Typography.Text
                strong
                style={{
                  fontSize: 14.5,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  lineHeight: 1.3,
                  minHeight: 38,
                }}
              >
                {service.name}
              </Typography.Text>
              <Tooltip title={favorited ? "取消收藏" : "收藏"}>
                <Button
                  type="text"
                  size="small"
                  style={{ position: "relative", zIndex: 3, pointerEvents: "auto" }}
                  icon={
                    favorited ? (
                      <StarFilled style={{ color: tokens.colorWarning }} />
                    ) : (
                      <StarOutlined />
                    )
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(service.id);
                  }}
                  aria-label={favorited ? "取消收藏" : "收藏"}
                />
              </Tooltip>
            </Flex>
            <Flex gap={6} align="center" wrap style={{ marginTop: 8 }}>
              <Tag
                color="blue"
                variant="filled"
                style={{ fontSize: 11.5, margin: 0 }}
              >
                {CATEGORY_LABEL[service.category] ?? service.category}
              </Tag>
              <Tooltip title={serviceHealthText(status)}>
                <span className={dotClass} />
              </Tooltip>
            </Flex>
          </div>
        </Flex>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 首页 */

export default function Home() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const [q, setQ] = useState("");
  const heroVars = useHeroBackdrop();

  const {
    data: servicesData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["services"],
    queryFn: api.services,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const { data: healthData } = useQuery({
    queryKey: ["services-health"],
    queryFn: api.servicesHealth,
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const { data: favData } = useQuery({
    queryKey: ["favorites"],
    queryFn: api.favorites,
    staleTime: 30_000,
  });
  const { data: recentData } = useQuery({
    queryKey: ["recent"],
    queryFn: api.recent,
    staleTime: 30_000,
  });
  const { data: annData } = useQuery({
    queryKey: ["announcements"],
    queryFn: api.announcements,
    staleTime: 60_000,
  });
  const { data: saying } = useQuery({
    queryKey: ["daily-saying"],
    queryFn: api.saying,
    staleTime: 60 * 60_000,
    retry: false,
  });
  const { data: wb } = useQuery({
    queryKey: ["workbench-summary", "home"],
    queryFn: api.workbenchSummary,
    staleTime: 60_000,
    retry: false,
  });
  const { data: todayWeather } = useQuery({
    queryKey: ["home-weather"],
    queryFn: () => api.weather("", 2),
    staleTime: 10 * 60_000,
    retry: false,
  });

  // Hero 搜索：实时建议（api.search），回车进入 /search
  const { data: searchData, isFetching: searching } = useQuery({
    queryKey: ["home-hero-search", q],
    queryFn: () => api.search(q.trim(), "general", "all"),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
    retry: false,
  });

  const favMutation = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.addFavorite(id) : api.removeFavorite(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["favorites"] });
    },
  });

  const services = useMemo(() => {
    const healthMap = new Map(
      (healthData?.services ?? []).map((s) => [s.id, s.health]),
    );
    return (servicesData?.services ?? []).map((s) => ({
      ...s,
      health: healthMap.get(s.id),
    }));
  }, [servicesData, healthData]);

  const online = services.filter((s) => s.health?.status === "up").length;
  const favorites = new Set(favData?.favorites ?? []);
  const recent = (recentData?.recent ?? [])
    .map((id) => services.find((s) => s.id === id))
    .filter((s): s is (typeof services)[number] => Boolean(s));

  // 常用服务：置顶优先，补齐到 12 张，同一服务只出现一次
  // 已经在快捷入口出现过的服务不再重复占位（见 SERVICES_ALREADY_IN_QUICK）。
  const homeServices = useMemo(() => {
    const byId = new Map(
      services.filter((s) => !SERVICES_ALREADY_IN_QUICK.has(s.id)).map((s) => [s.id, s]),
    );
    const picked: ServiceItem[] = [];
    for (const id of PINNED) {
      const hit = byId.get(id);
      if (hit) {
        picked.push(hit);
        byId.delete(id);
      }
    }
    for (const s of byId.values()) {
      if (picked.length >= HOME_SERVICE_COUNT) break;
      picked.push(s);
    }
    return picked.slice(0, HOME_SERVICE_COUNT);
  }, [services]);

  const suggestions = (searchData?.results ?? []).slice(0, 6);

  const dueToday = wb?.today?.dueToday?.length ?? 0;
  const overdue = wb?.today?.overdue?.length ?? 0;
  const activeTasks = wb?.stats?.activeTasks ?? 0;
  const nextTasks = [
    ...(wb?.today?.overdue ?? []),
    ...(wb?.today?.dueToday ?? []),
  ].slice(0, 2);

  const dotClass = serviceDotClass;

  /** 仅允许站内路径或 http(s) 链接，避免跳转异常地址。 */
  const openSearchHit = (url: string) => {
    if (!url) return;
    // 站内路径走前端路由；"//host" 是协议相对地址，交由外链分支处理
    if (url.startsWith("/") && !url.startsWith("//")) {
      navigate(url);
      return;
    }
    try {
      const u = new URL(url, window.location.origin);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      // 用锚点而不是 window.open：既能带上 rel="noopener noreferrer"
      // （新标签页拿不到 opener，也不会把 referrer 泄给外站），
      // 又不会把待跳转的地址直接交给导航 API。
      const link = document.createElement("a");
      link.href = u.toString();
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      /* 忽略非法链接 */
    }
  };

  const latestAnn = annData?.announcements?.[0];
  const cur = todayWeather?.current;

  const renderSearchSuggestions = () => {
    if (q.trim().length < 2) return null;
    if (searching) {
      return (
        <Flex gap={10} align="center" style={{ marginTop: 6, minHeight: 22, overflow: "hidden" }}>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>检索中…</Typography.Text>
        </Flex>
      );
    }
    if ((searchData?.results?.length ?? 0) === 0) {
      return (
        <Flex gap={10} align="center" style={{ marginTop: 6, minHeight: 22, overflow: "hidden" }}>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>没有匹配结果</Typography.Text>
        </Flex>
      );
    }
    return (
      <Flex gap={10} align="center" style={{ marginTop: 6, minHeight: 22, overflow: "hidden" }}>
        <Typography.Text type="secondary" style={{ fontSize: 11.5, flexShrink: 0 }}>
          共 {searchData?.results?.length} 条
        </Typography.Text>
        {suggestions.slice(0, 3).map((r, i) => (
          <button
            key={`${r.url || r.path}-${i}`}
            type="button"
            onClick={() => openSearchHit(r.url || r.path || "")}
            style={{
              border: 0,
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--hero-accent)",
              maxWidth: 150,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {r.title}
          </button>
        ))}
        <Typography.Link
          onClick={() => navigate(`/search?q=${encodeURIComponent(q.trim())}`)}
          style={{ fontSize: 11.5, flexShrink: 0, whiteSpace: "nowrap" }}
        >
          查看全部 <ArrowRightOutlined style={{ fontSize: 10 }} />
        </Typography.Link>
      </Flex>
    );
  };

  const renderServices = () => {
    if (error && services.length === 0) {
      return (
        <Alert
          type="error"
          showIcon
          title="服务列表加载失败"
          description={error instanceof Error ? error.message : "请稍后重试"}
          action={<Button size="small" onClick={() => void refetch()}>重试</Button>}
        />
      );
    }
    if (isLoading && services.length === 0) {
      return (
        <Row gutter={[14, 14]}>
          {Array.from({ length: HOME_SERVICE_COUNT }).map((_, i) => (
            <Col key={i} xs={24} sm={12} lg={8}>
              <Card size="small" styles={{ body: { padding: 16 } }}>
                <Skeleton active title={{ width: "52%" }} paragraph={{ rows: 1, width: ["80%", "45%"] }} />
              </Card>
            </Col>
          ))}
        </Row>
      );
    }
    if (homeServices.length === 0) {
      return <Card size="small"><Empty description="暂无可用服务" /></Card>;
    }
    return (
      <Row gutter={[14, 14]}>
        {homeServices.map((s) => (
          <Col key={s.id} xs={24} sm={12} lg={8}>
            <ServiceTile
              service={s}
              favorited={favorites.has(s.id)}
              onToggleFavorite={(id) => favMutation.mutate({ id, on: !favorites.has(id) })}
            />
          </Col>
        ))}
      </Row>
    );
  };

  return (
    <Flex vertical gap={18} className="d509-enter">
      {/* ---------------------------------------------- ① Hero */}
      <div className="d509-hero" style={heroVars}>
        <div className="d509-hero-bg" aria-hidden />
        <div className="d509-hero-glow" aria-hidden />
        <Row gutter={[24, 16]} align="top">
          <Col xs={24} lg={15}>
            {latestAnn ? (
              <Popover
                trigger="click"
                placement="bottomLeft"
                title={
                  <Flex gap={6} align="center">
                    <span>{latestAnn.title}</span>
                    {latestAnn.level && latestAnn.level !== "info" ? (
                      <Tag
                        color={latestAnn.level === "warning" ? "gold" : "green"}
                        variant="filled"
                        style={{ fontSize: 11, marginInlineEnd: 0 }}
                      >
                        {latestAnn.level === "warning" ? "提醒" : "通知"}
                      </Tag>
                    ) : null}
                  </Flex>
                }
                content={
                  <div
                    style={{
                      maxWidth: 360,
                      whiteSpace: "pre-wrap",
                      fontSize: 13,
                      lineHeight: 1.7,
                    }}
                  >
                    {latestAnn.content}
                    {latestAnn.created_at ? (
                      <div
                        style={{ marginTop: 8, fontSize: 11.5, opacity: 0.6 }}
                      >
                        {latestAnn.created_at}
                      </div>
                    ) : null}
                  </div>
                }
              >
                <button type="button" className="d509-hero-ann">
                  <NotificationOutlined className="d509-hero-ann-icon" />
                  <span className="d509-hero-ann-tag">
                    {latestAnn.level === "warning" ? "提醒" : "公告"}
                  </span>
                  <span className="d509-hero-ann-title">{latestAnn.title}</span>
                  <span className="d509-hero-ann-text">
                    {latestAnn.content}
                  </span>
                  <ArrowRightOutlined className="d509-hero-ann-arrow" />
                </button>
              </Popover>
            ) : null}

            <Flex gap={8} align="center" wrap style={{ marginBottom: 8 }}>
              <Tag
                color="blue"
                variant="filled"
                style={{ fontSize: 11.5, margin: 0 }}
              >
                D509 实验室工作台
              </Tag>
              {cur ? (
                <Tooltip
                  title={`${todayWeather?.city || "本地"} · ${cur.description} · 体感 ${cur.apparent ?? "—"}°C · 湿度 ${cur.humidity ?? "—"}%`}
                >
                  <span className="d509-hero-weather" role="status">
                    <span className="d509-hero-weather-icon" aria-hidden>
                      {weatherGlyph(cur.code)}
                    </span>
                    {cur.temperature == null ? null : (
                      <span className="d509-hero-weather-temp">
                        {Math.round(cur.temperature)}°C
                      </span>
                    )}
                    <span className="d509-hero-weather-desc">
                      {cur.description}
                    </span>
                  </span>
                </Tooltip>
              ) : null}
            </Flex>
            <Typography.Title
              level={2}
              className="d509-title"
              style={{ margin: 0, fontSize: 26 }}
            >
              你好
              {me?.displayName || me?.name
                ? `，${me.displayName || me.name}`
                : ""}
              ，今天想做什么？
            </Typography.Title>

            <div style={{ marginTop: 14 }}>
              <Input.Search
                size="large"
                allowClear
                enterButton={
                  <span>
                    <SearchOutlined /> 搜索
                  </span>
                }
                placeholder="搜索服务、Linux 命令、植物数据库或课程资料…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onSearch={(v) => {
                  const s = v.trim();
                  if (s) navigate(`/search?q=${encodeURIComponent(s)}`);
                }}
                style={{ width: "100%", maxWidth: 560 }}
              />
              {/* 实时建议（api.search）：固定单行，避免挤压 Hero 高度 */}
              {renderSearchSuggestions()}
            </div>
          </Col>

          <Col xs={24} lg={9}>
            <div className="d509-hero-side">
              <div>
                <Flex gap={8} align="center">
                  <Tag
                    color="blue"
                    variant="filled"
                    style={{ margin: 0, fontSize: 11 }}
                  >
                    每日诗词
                  </Tag>
                  {saying?.date ? (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {saying.date}
                    </Typography.Text>
                  ) : null}
                </Flex>
                <Typography.Paragraph
                  style={{
                    margin: "8px 0 0",
                    fontSize: 15,
                    lineHeight: 1.75,
                    fontWeight: 500,
                  }}
                  ellipsis={{ rows: 3, tooltip: saying?.text }}
                >
                  “{saying?.text ?? "人间有味是清欢。"}”
                </Typography.Paragraph>
                {/* 诗词必须能看出作者与出处：只给一句孤零零的诗，读的人没法核对 */}
                {saying?.author || saying?.origin ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {[saying.author, saying.origin && `《${saying.origin}》`]
                      .filter(Boolean)
                      .join(" · ")}
                  </Typography.Text>
                ) : null}
              </div>

              <div className="d509-hero-side-section">
                <Flex justify="space-between" align="center">
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    今日任务
                  </Typography.Text>
                  <Typography.Link
                    style={{ fontSize: 12 }}
                    onClick={() => navigate("/workbench")}
                  >
                    打开工作台 <ArrowRightOutlined style={{ fontSize: 10 }} />
                  </Typography.Link>
                </Flex>
                <Flex gap={20} align="baseline" wrap style={{ marginTop: 6 }}>
                  <span
                    style={{ fontSize: 12, color: "rgba(255, 255, 255, 0.68)" }}
                  >
                    <b
                      style={{
                        color: "var(--hero-accent)",
                        fontSize: 19,
                        marginRight: 3,
                      }}
                    >
                      {dueToday}
                    </b>
                    今日到期
                  </span>
                  <span
                    style={{ fontSize: 12, color: "rgba(255, 255, 255, 0.68)" }}
                  >
                    <b
                      style={{
                        color: overdue ? palette.brand.coral200 : palette.tint.green200,
                        fontSize: 19,
                        marginRight: 3,
                      }}
                    >
                      {overdue}
                    </b>
                    逾期
                  </span>
                  <span
                    style={{ fontSize: 12, color: "rgba(255, 255, 255, 0.68)" }}
                  >
                    <b style={{ color: "#fff", fontSize: 19, marginRight: 3 }}>
                      {activeTasks}
                    </b>
                    进行中
                  </span>
                </Flex>
                {nextTasks.length ? (
                  <Flex vertical gap={4} style={{ marginTop: 8 }}>
                    {nextTasks.map((t) => (
                      <Flex key={t.id} gap={6} align="center">
                        <ClockCircleOutlined
                          style={{ fontSize: 11, color: palette.brand.amber200 }}
                        />
                        <Typography.Text ellipsis style={{ fontSize: 12 }}>
                          {t.title}
                        </Typography.Text>
                      </Flex>
                    ))}
                  </Flex>
                ) : (
                  <Typography.Text
                    type="secondary"
                    style={{ display: "block", marginTop: 6, fontSize: 12 }}
                  >
                    今天没有到期任务，保持节奏。
                  </Typography.Text>
                )}
              </div>

              <div className="d509-hero-side-section">
                <Flex gap={24}>
                  <Metric
                    label="可用服务"
                    value={services.length}
                    suffix="个"
                    accent="var(--hero-accent)"
                  />
                  <Metric
                    label="当前在线"
                    value={online}
                    suffix={`/ ${services.length}`}
                    accent={palette.tint.green200}
                  />
                </Flex>
              </div>
            </div>
          </Col>
        </Row>
      </div>

      {/* ---------------------------------------------- ② 快捷入口 */}
      <section>
        <Flex
          align="center"
          justify="space-between"
          style={{ marginBottom: 10 }}
        >
          <Typography.Text className="d509-section-title">
            快捷入口
          </Typography.Text>
        </Flex>
        <div
          className="d509-stagger d509-grid d509-quick-grid"
          data-tour="quick"
        >
          {QUICK_ENTRIES.map((it) => (
            <button
              key={it.key}
              type="button"
              className="d509-tile"
              onClick={() => navigate(it.path)}
            >
              <span
                className="d509-icon"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  fontSize: 16,
                  background: `${it.color}14`,
                  color: it.color,
                }}
              >
                {it.icon}
              </span>
              <span style={{ minWidth: 0, textAlign: "left" }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, lineHeight: 1.25 }}>
                  {it.label}
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                  {it.desc}
                </Typography.Text>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------- ③ 主区：常用服务 + 今日面板 */}
      <Row gutter={[18, 18]}>
        <Col xs={24} xl={16}>
          <section>
            <Flex
              align="center"
              justify="space-between"
              style={{ marginBottom: 10 }}
            >
              <Typography.Text className="d509-section-title">
                常用服务
              </Typography.Text>
              <Flex gap={10} align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  共 {services.length} 个
                </Typography.Text>
              </Flex>
            </Flex>

            {renderServices()}
          </section>
        </Col>

        <Col xs={24} xl={8}>
          {/*
            右栏整体吸顶：把「公告」和「今日面板」放进**同一个**吸顶单元。
            之前只有"今日面板"是 position:sticky，它在滚动时会向上越过同栏的
            "公告"卡片、把公告压在下面（视觉上像两张卡重叠）；整栏作为一个
            单元一起跟随，两张卡之间就只差一个固定间距，不会互相压。
            整栏高度约 560px < 视口可用高度，吸顶时底部不会被截掉。
          */}
          <div className="d509-sticky-panel">
            <Flex vertical gap={18}>
              {/*
                  公告：**独立成卡片放在右栏顶部**，而不是塞进「动态 → 公告」的
                  二级页签——那样首页默认根本看不到，等于没做。
                  多条公告用 antd 原生 Masonry 叠层，短公告不被拉成长条。
                */}
              <Card
                size="small"
                title="公告"
                className="d509-glass"
                styles={{ body: { padding: "12px 12px 14px" } }}
                extra={
                  annData?.announcements?.length ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      共 {annData.announcements.length} 条
                    </Typography.Text>
                  ) : null
                }
              >
                {(annData?.announcements?.length ?? 0) > 0 ? (
                  <Masonry
                    columns={{ xs: 1, sm: 1, md: 2 }}
                    gutter={10}
                    items={annData!.announcements
                      .slice(0, 6)
                      .map((a: any) => ({ key: a.id, data: a }))}
                    itemRender={(item) => {
                      const a = item.data as any;
                      return (
                        <div
                          style={{
                            border:
                              "1px solid var(--ant-color-border-secondary)",
                            borderRadius: 10,
                            padding: "10px 12px",
                            background:
                              "var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))",
                          }}
                        >
                          <Flex gap={6} align="center" wrap>
                            <Typography.Text strong style={{ fontSize: 13 }}>
                              {a.title}
                            </Typography.Text>
                            {a.level && a.level !== "info" ? (
                              <Tag
                                variant="filled"
                                color={a.level === "warning" ? "gold" : "green"}
                                style={{ fontSize: 11, margin: 0 }}
                              >
                                {a.level === "warning" ? "提醒" : "通知"}
                              </Tag>
                            ) : null}
                          </Flex>
                          <Typography.Paragraph
                            type="secondary"
                            style={{
                              fontSize: 12.5,
                              margin: "6px 0 0",
                              lineHeight: 1.65,
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {a.content}
                          </Typography.Paragraph>
                        </div>
                      );
                    }}
                  />
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无公告"
                  />
                )}
              </Card>
              <Card
                size="small"
                title="今日面板"
                styles={{ body: { padding: "4px 0 0" } }}
              >
                <Tabs
                  size="small"
                  defaultActiveKey="search"
                  tabBarStyle={{ marginBottom: 0, paddingInline: 12 }}
                  items={[
                    {
                      key: "search",
                      label: "学术检索",
                      children: (
                        <div style={{ padding: "12px 12px 16px" }}>
                          <AcademicSearch />
                        </div>
                      ),
                    },
                    {
                      key: "plant",
                      label: "植物数据库",
                      children: (
                        <div style={{ padding: "12px 12px 16px" }}>
                          <PlantDatabasePanel />
                        </div>
                      ),
                    },
                    {
                      key: "feed",
                      label: "动态",
                      children: (
                        <div style={{ padding: "0 0 8px" }}>
                          <Tabs
                            size="small"
                            defaultActiveKey="notice"
                            tabBarStyle={{ marginBottom: 0, paddingInline: 12 }}
                            items={[
                              {
                                key: "fav",
                                label: (
                                  <span>
                                    <StarOutlined /> 收藏
                                    {favorites.size > 0
                                      ? ` (${favorites.size})`
                                      : ""}
                                  </span>
                                ),
                                children:
                                  favorites.size === 0 ? (
                                    <Empty
                                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                                      description="还没有收藏服务"
                                    />
                                  ) : (
                                    <Flex
                                      vertical
                                      gap={8}
                                      style={{ padding: "12px 16px 16px" }}
                                    >
                                      {services
                                        .filter((s) => favorites.has(s.id))
                                        .slice(0, 8)
                                        .map((s) => (
                                          <Flex
                                            key={s.id}
                                            gap={8}
                                            align="center"
                                          >
                                            <span
                                              className={dotClass(
                                                s.health?.status,
                                              )}
                                            />
                                            <Typography.Link
                                              onClick={() =>
                                                navigate(serviceTarget(s))
                                              }
                                              style={{ fontSize: 13 }}
                                            >
                                              {s.name}
                                            </Typography.Link>
                                          </Flex>
                                        ))}
                                    </Flex>
                                  ),
                              },
                              {
                                key: "recent",
                                label: (
                                  <span>
                                    <ClockCircleOutlined /> 最近
                                  </span>
                                ),
                                children:
                                  recent.length === 0 ? (
                                    <Empty
                                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                                      description="还没有访问记录"
                                    />
                                  ) : (
                                    <Flex
                                      vertical
                                      gap={8}
                                      style={{ padding: "12px 16px 16px" }}
                                    >
                                      {recent.slice(0, 8).map((s) => (
                                        <Flex key={s.id} gap={8} align="center">
                                          <span
                                            className={dotClass(
                                              s.health?.status,
                                            )}
                                          />
                                          <Typography.Link
                                            onClick={() =>
                                              navigate(serviceTarget(s))
                                            }
                                            style={{ fontSize: 13 }}
                                          >
                                            {s.name}
                                          </Typography.Link>
                                        </Flex>
                                      ))}
                                    </Flex>
                                  ),
                              },
                            ]}
                          />
                        </div>
                      ),
                    },
                  ]}
                />
              </Card>
            </Flex>
          </div>
        </Col>
      </Row>

      <Flex
        justify="space-between"
        align="center"
        wrap
        gap={8}
        className="d509-home-foot"
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          D509 实验室 · 教学与科研一体化入口
        </Typography.Text>
        <Flex gap={16}>
          <Typography.Link
            onClick={() => navigate("/workbench")}
            style={{ fontSize: 12.5 }}
          >
            个人工作台
          </Typography.Link>
          <Typography.Link
            onClick={() => navigate("/files")}
            style={{ fontSize: 12.5 }}
          >
            文件共享
          </Typography.Link>
        </Flex>
      </Flex>
    </Flex>
  );
}
