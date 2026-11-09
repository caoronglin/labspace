#!/usr/bin/env python3
"""JBrowse 4 静态包中文补丁。

JBrowse 4 官方发行包没有 i18n 机制，菜单与面板文案是编译进 bundle 的英文字符串。
这里按 label:"..." 的形式做精确字符串替换，把界面文案换成中文。

用法:
  python3 jbrowse-zh.py            # 应用补丁（自动备份一次）
  python3 jbrowse-zh.py --check    # 只统计可替换项
  python3 jbrowse-zh.py --restore  # 从备份还原
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

JS_DIR = Path("/srv/labdata/jbrowse/web/static/js")
BACKUP_DIR = Path("/srv/labdata/jbrowse/backup-static-zh")

# 英文原文 -> 中文译文
PAIRS: list[tuple[str, str]] = [
    ("+i+", "+i+"), ("+o+", "+o+"), (".", "。"),
    ("A", "全选"), ("About", "关于"), ("About track", "关于该轨道"),
    ("Actions", "操作"), ("Adapter type", "适配器类型"), ("Add", "添加"),
    ("Add connection...", "添加连接…"), ("Add to favorites", "加入收藏"),
    ("Add to selection", "加入选区"), ("Add track...", "添加轨道…"),
    ("Add tracks to selection instead of turning them on/off", "将轨道加入选区而不是开启或关闭"),
    ("Add window size in bp", "以 bp 添加窗口大小"), ("Adjust to height of display", "调整为显示高度"),
    ("Admin", "管理员"), ("All modifications (<50% prob colored blue)", "所有修饰（概率 <50% 标为蓝色）"),
    ("All reference CpGs", "所有参考 CpG"), ("All transcripts", "所有转录本"),
    ("Allele count (dosage)", "等位基因计数（剂量）"), ("Allow clicking alignment squiggles?", "允许点击比对波形？"),
    ("Alt allele 1", "备选等位基因 1"), ("Alt allele 2", "备选等位基因 2"), ("Alt allele 3", "备选等位基因 3"),
    ("Arcs", "弧线"), ("Assembly display name", "组装显示名称"), ("Assembly manager", "组装管理器"),
    ("Assembly name", "组装名称"), ("Auto-adjust to display height", "自动调整为显示高度"),
    ("Autoscale type", "自动缩放类型"), ("BED1 assembly", "BED1 组装"), ("BED2 assembly", "BED2 组装"),
    ("Bold", "加粗"), ("Bookmark current region", "收藏当前区域"),
    ("Bookmark highlighted region", "收藏高亮区域"), ("Bookmark region", "收藏区域"),
    ("Bookmarks/highlights", "书签/高亮"), ("C", "C"), ("CJS build URL", "CJS 构建地址"),
    ("Capitalization from reference genome sequence", "依据参考基因组序列的大小写"),
    ("Capitalize CDS and lower case everything else", "CDS 首字母大写，其余小写"),
    ("Case insensitive", "不区分大小写"), ("Center on feature", "居中到特征"),
    ("Center view here", "视图居中于此"), ("Change GC parameters", "修改 GC 参数"),
    ("Circular view", "环形视图"), ("Clear selection", "清除选区"), ("Clear sort", "清除排序"),
    ("Clear subtree filter", "清除子树筛选"), ("Click and drag mode", "点击拖动模式"),
    ("Close tab", "关闭标签页"), ("Cluster by genotype", "按基因型聚类"),
    ("Cluster rows by score", "按分数对行聚类"), ("Coarser resolution", "粗分辨率"),
    ("Collapse all subcategories", "折叠所有子分类"), ("Collapse into folder", "折叠进文件夹"),
    ("Collapse introns", "折叠内含子"), ("Collapse subcategories", "折叠子分类"),
    ("Collapse top-level categories", "折叠顶层分类"), ("Collapse...", "折叠…"),
    ("Color", "颜色"), ("Color by CDS and draw amino acids", "按 CDS 着色并绘制氨基酸"),
    ("Color by tag...", "按标签着色…"), ("Color by...", "着色方式…"), ("Color scheme", "配色方案"),
    ("Compact", "紧凑"), ("Complement sequence", "反义序列"), ("Connections...", "连接…"),
    ("Coordinates relative to feature start", "相对于特征起点的坐标"),
    ("Coordinates relative to genome (only available for continuous genome based sequence types)",
     "相对于基因组的坐标（仅连续基因组序列类型可用）"),
    ("Copy HTML", "复制 HTML"), ("Copy info to clipboard", "复制信息到剪贴板"),
    ("Copy plaintext", "复制纯文本"), ("Copy range", "复制区间"), ("Copy track", "复制轨道"),
    ("Copy tracks into the new view", "将轨道复制到新视图"), ("Copy view", "复制视图"),
    ("CpG methylated", "CpG 甲基化"), ("CpG unmethylated", "CpG 未甲基化"),
    ("Create multi-wiggle track", "创建多 wiggle 轨道"), ("Custom", "自定义"),
    ("Custom zoom", "自定义缩放"), ("D' (normalized D)", "D'（标准化 D）"), ("Default", "默认"),
    ("Delete", "删除"), ("Delete connections...", "删除连接…"), ("Delete track", "删除轨道"),
    ("Delete tracks", "删除轨道"), ("Deletion", "缺失"), ("Disable", "禁用"),
    ("Dismiss highlight", "取消高亮"), ("Display mode", "显示模式"), ("Display types", "显示类型"),
    ("Dotplot of read vs ref", "读段与参考的 dotplot"), ("Dotplot view", "dotplot 视图"),
    ("Download HTML", "下载 HTML"), ("Download plaintext", "下载纯文本"),
    ("Draw CIGAR insertions/deletions", "绘制 CIGAR 插入/缺失"), ("Duplicate session", "复制会话"),
    ("ESM build URL", "ESM 构建地址"), ("Edit colors", "编辑颜色"),
    ("Edit colors/arrangement...", "编辑颜色/排列…"), ("Edit filters", "编辑筛选器"),
    ("Edit filters...", "编辑筛选器…"), ("Edit group colors/arrangement...", "编辑分组颜色/排列…"),
    ("Enable HWE filter", "启用 HWE 筛选"), ("Enable call rate filter", "启用检出率筛选"),
    ("Enter Share URL", "输入共享地址"), ("Enter Token", "输入令牌"), ("Existing track", "已有轨道"),
    ("Expand all categories", "展开全部分类"), ("Expand all subcategories", "展开所有子分类"),
    ("Expand to category", "展开到分类"), ("Export", "导出"), ("Export SVG", "导出 SVG"),
    ("Export session", "导出会话"), ("Extra bold", "特粗"), ("Fall", "下降"),
    ("Favorite sessions...", "收藏的会话…"), ("Feature types to exclude", "要排除的特征类型"),
    ("File", "文件"), ("Fill mode", "填充模式"), ("Filter arcs by score...", "按分数筛选弧线…"),
    ("Filter by", "筛选条件"), ("Filter by...", "按条件筛选…"), ("Filter plugins", "筛选插件"),
    ("Filter tracks", "筛选轨道"), ("Finer resolution", "细分辨率"),
    ("First-of-pair forward", "双端第一条为正向"), ("First-of-pair reverse", "双端第一条为反向"),
    ("Focus on breakends", "聚焦断点"), ("Forward strand", "正向链"), ("G", "G"),
    ("Gene glyph", "基因字形"), ("General JEXL filters...", "通用 JEXL 筛选器…"),
    ("Get sequence", "获取序列"), ("Global: change layout into set of tabs", "全局：切换为标签页布局"),
    ("Global: tile grid", "全局：平铺网格"), ("Global: tile horizontally", "全局：水平平铺"),
    ("Global: tile vertically", "全局：垂直平铺"), ("Group by...", "分组依据…"),
    ("Hard clip", "硬剪切"), ("Help", "帮助"), ("Heterozygous alt", "杂合备选"),
    ("Hidden", "隐藏"), ("Hide all", "全部隐藏"), ("Homozygous alt", "纯合备选"),
    ("Homozygous reference", "纯合参考"), ("Horizontally flip", "水平翻转"), ("Identity", "一致性"),
    ("Import", "导入"), ("Import session...", "导入会话…"),
    ("Index track for text searching?", "为文本检索建立轨道索引？"), ("Indexing attributes", "索引属性"),
    ("Insert size", "插入片段长度"), ("Insert size gradient", "插入片段长度梯度"),
    ("Insert size ± 3σ", "插入片段长度 ± 3σ"), ("Insert size ± 3σ and orientation", "插入片段长度 ± 3σ 与方向"),
    ("Insertion", "插入"), ("Insertion/clipping counts", "插入/剪切计数"),
    ("Insertion/clipping indicators", "插入/剪切指示"), ("Inter-chromosomal", "染色体间"),
    ("Inter-chromosomal connections (purple vertical lines)", "染色体间连接（紫色竖线）"),
    ("Jitter x-positions", "抖动 x 位置"), ("Jobs list", "任务列表"), ("Juicebox", "Juicebox"),
    ("Keep view header visible", "保持视图头部可见"), ("LD metric", "LD 度量"),
    ("LD triangle adjusted to display height", "按显示高度调整 LD 三角"),
    ("LD-specific filters...", "LD 专用筛选器…"), ("LL - Both mates forward strand", "LL - 两条均为正向链"),
    ("LR - Normal pair orientation", "LR - 常规配对方向"), ("Large", "大"),
    ("Launch synteny view for this position", "在此位置启动共线性视图"), ("Line width", "线宽"),
    ("Linear genome view", "线性基因组视图"), ("Linear read vs ref", "线性读段与参考"),
    ("Linear scale", "线性刻度"), ("Linear synteny view", "线性共线性视图"),
    ("Link views", "链接视图"), ("Loading modifications...", "正在加载修饰…"),
    ("Log scale", "对数刻度"), ("Long URL", "长地址"), ("Long insert", "长插入"),
    ("Long range connections (red vertical lines)", "长程连接（红色竖线）"),
    ("Longest coding transcript", "最长编码转录本"), ("Longest transcript", "最长转录本"),
    ("MAF threshold", "MAF 阈值"), ("MAF threshold (0-0.5)", "MAF 阈值（0-0.5）"),
    ("Manage columns", "管理列"), ("Manually set height...", "手动设置高度…"),
    ("Manually set row height", "手动设置行高"), ("Mapping Quality", "比对质量"),
    ("Mapping quality", "比对质量"), ("Mean Query Identity", "平均查询一致性"),
    ("Minimum call rate (0-1)", "最低检出率（0-1）"), ("Minimum read support", "最小读段支持度"),
    ("Minor allele frequency", "次要等位基因频率"), ("Mirror the copied tracks", "镜像复制的轨道"),
    ("Mismatch/indel display", "错配/indel 显示"), ("Modifications", "修饰"), ("More...", "更多…"),
    ("Move left", "左移"), ("Move right", "右移"), ("Move to far left", "移到最左"),
    ("Move to far right", "移到最右"), ("Move to new tab", "移到新标签页"),
    ("Move to split view (right side of screen)", "移至分屏视图（屏幕右侧）"),
    ("Move track down", "轨道下移"), ("Move track to bottom", "轨道移到底部"),
    ("Move track to top", "轨道移到顶部"), ("Move track up", "轨道上移"),
    ("Move view down", "视图下移"), ("Move view to bottom", "视图移到底部"),
    ("Move view to top", "视图移到顶部"), ("Move view up", "视图上移"),
    ("New empty split horizontal", "新建空白水平分屏"), ("New empty split vertical", "新建空白垂直分屏"),
    ("New empty tab", "新建空白标签页"), ("New session", "新建会话"), ("New track", "新建轨道"),
    ("No autosaves found", "未找到自动保存"), ("No call", "无检出"), ("No coordinates", "无坐标"),
    ("No modifications currently visible", "当前没有可见的修饰"), ("None", "无"),
    ("Normal", "标准"), ("Normalization scheme", "归一化方案"),
    ("Note: The feature is inverted in orientation on the target sequence. This will result in the lower panel having genomic coordinates decreasing left to right. Horizontally flip?",
     "注意：该特征在目标序列上方向为反向，下方面板中的基因组坐标将从左到右递减。是否水平翻转？"),
    ("Number of bases up/down stream of feature to display", "特征上下游显示的碱基数"),
    ("Number of bp around splice site to include", "包含的剪接位点周围碱基数"),
    ("Number of intronic bases around splice site to display", "剪接位点周围显示的内含子碱基数"),
    ("Offset", "偏移"), ("Open as faceted selector...", "以分面选择器打开…"),
    ("Open bookmark widget", "打开书签组件"), ("Open connection...", "打开连接…"),
    ("Open faceted track selector", "打开分面轨道选择器"), ("Open feature details", "打开特征详情"),
    ("Open in breakpoint split view", "在断点分屏视图打开"), ("Open in dialog", "在对话框打开"),
    ("Open in linear genome view", "在线性基因组视图打开"), ("Open linear synteny view", "打开线性共线性视图"),
    ("Open track selector", "打开轨道选择器"), ("Open track...", "打开轨道…"),
    ("Orientation", "方向"), ("Orientation - Side-by-side", "方向 - 并排"),
    ("Orientation - Vertical", "方向 - 垂直"), ("Other alt allele", "其他备选等位基因"),
    ("Overall color", "整体颜色"), ("Overlapping", "重叠"), ("P-value threshold", "P 值阈值"),
    ("Pair orientation", "配对方向"), ("Pan by default", "默认平移"), ("Pan view", "平移视图"),
    ("Password", "密码"), ("Per-base lettering", "逐碱基字母标记"), ("Per-base quality", "逐碱基质量"),
    ("Phased", "已定相"), ("Pileup settings", "Pileup 设置"), ("Plugin URL", "插件地址"),
    ("Plugin name", "插件名称"), ("Plugin store", "插件商店"), ("Positive/negative color", "正/负着色"),
    ("Pre-configured sessions...", "预置会话…"), ("Preferences", "首选项"), ("Query", "查询"),
    ("Query assembly", "查询组装"), ("RL - Mates point outward", "RL - 两条向外"),
    ("RR - Both mates reverse strand", "RR - 两条均为反向链"),
    ("Rasterize canvas based tracks? File may be much larger if this is turned off",
     "将基于画布的轨道栅格化？关闭后文件可能大得多"),
    ("Re-order chromosomes", "重排染色体"), ("Recent sessions...", "最近的会话…"),
    ("Rectangular view - same total bp", "矩形视图 - 相同总 bp"), ("Redo", "重做"),
    ("Reference", "参考"), ("Region", "区域"), ("Remove bookmark", "移除书签"),
    ("Remove from favorites", "移出收藏"), ("Remove from selection", "移出选区"),
    ("Remove spacing between features in y-direction?", "移除 y 方向特征间距？"),
    ("Remove this region from view", "从视图中移除该区域"), ("Rename tab", "重命名标签页"),
    ("Renderer type", "渲染器类型"), ("Rendering mode", "渲染模式"),
    ("Replace lower panel with...", "替换下方面板为…"), ("Resolution", "分辨率"),
    ("Return to import form", "返回导入表单"), ("Reverse sequence", "反向序列"),
    ("Reverse strand", "反向链"), ("Reverse view order", "反转视图顺序"), ("Row height", "行高"),
    ("Row track selectors", "行轨道选择器"), ("Row view menus", "视图行菜单"),
    ("R² (squared correlation)", "R²（平方相关系数）"), ("SNPCoverage settings", "SNP 覆盖度设置"),
    ("SV inspector", "SV 检查器"),
    ("Samples per pixel (>1 for denser sampling, between 0-1 for sparser sampling)",
     "每像素采样数（>1 更密，0-1 更稀疏）"),
    ("Sashimi arcs", "Sashimi 弧线"), ("Save track data", "保存轨道数据"), ("Scale type", "刻度类型"),
    ("Score", "分数"), ("Search forward strand", "搜索正向链"), ("Search reverse strand", "搜索反向链"),
    ("Search...", "搜索…"), ("Select region by default", "默认选中区域"), ("Semi-circles", "半圆"),
    ("Sequence search", "序列检索"), ("Set default session", "设为默认会话"),
    ("Set feature height...", "设置特征高度…"), ("Set max track height", "设置轨道最大高度"),
    ("Set max track height...", "设置轨道最大高度…"), ("Set min/max score", "设置最小/最大分数"),
    ("Set window size", "设置窗口大小"), ("Settings", "设置"), ("Share", "共享"),
    ("Short URL", "短地址"), ("Short insert", "短插入"),
    ("Show CIGAR insertions/deletions", "显示 CIGAR 插入/缺失"),
    ("Show CIGAR matches only", "仅显示 CIGAR 匹配"), ("Show LD triangle", "显示 LD 三角"),
    ("Show all", "显示全部"), ("Show all mismatches", "显示所有错配"), ("Show all regions", "显示所有区域"),
    ("Show all regions in assembly", "显示组装中的所有区域"),
    ("Show as 'read cloud' (paired-end reads)", "以「读段云」显示（双端读段）"),
    ("Show center line", "显示中心线"), ("Show chevrons", "显示雪佛龙标记"),
    ("Show coordinates?", "显示坐标？"), ("Show cross hatches", "显示交叉线"),
    ("Show curved lines", "显示曲线"), ("Show descriptions", "显示描述"),
    ("Show dynamic controls", "显示动态控件"), ("Show facet filters", "显示分面筛选器"),
    ("Show favorites only?", "仅显示收藏？"), ("Show filters", "显示筛选器"),
    ("Show forward", "显示正向"), ("Show frequency table", "显示频率表"),
    ("Show gridlines", "显示网格线"), ("Show guidelines", "显示参考线"), ("Show header", "显示头部"),
    ("Show header overview", "显示头部概览"), ("Show ideogram", "显示染色体核型图"),
    ("Show intra-view links", "显示视图内链接"), ("Show inverted", "显示反向"),
    ("Show just large indels", "仅显示较大 indel"), ("Show labels", "显示标签"),
    ("Show legend", "显示图例"), ("Show location markers", "显示位置标记"),
    ("Show mismatches and large indels+clipping", "显示错配与大 indel 及剪切"),
    ("Show mismatches faded by quality", "按质量淡化显示错配"),
    ("Show no tracks active button", "显示「无激活轨道」按钮"), ("Show none", "不显示"),
    ("Show only genes", "仅显示基因"), ("Show outline", "显示轮廓"), ("Show pan buttons", "显示平移按钮"),
    ("Show proper pairs", "显示正确配对"), ("Show read strand relative to primary", "相对主链显示读段链方向"),
    ("Show recombination track", "显示重组轨道"), ("Show reference alleles", "显示参考等位基因"),
    ("Show reverse", "显示反向"), ("Show search boxes", "显示检索框"), ("Show sidebar", "显示侧边栏"),
    ("Show sidebar labels", "显示侧边栏标签"), ("Show signed LD values (-1 to 1)", "显示带符号的 LD 值（-1 到 1）"),
    ("Show singletons", "显示孤立读段"), ("Show soft clipping", "显示软剪切"),
    ("Show sparse metadata columns", "显示稀疏元数据列"), ("Show toolbar", "显示工具栏"),
    ("Show tooltips", "显示提示信息"), ("Show track outlines", "显示轨道轮廓"), ("Show translation", "显示翻译"),
    ("Show tree", "显示树"), ("Show y-scalebar", "显示 y 轴标尺"), ("Show...", "显示…"),
    ("Size of sliding window (bp)", "滑动窗口大小（bp）"), ("Small", "小"), ("Soft clip", "软剪切"),
    ("Sort by tag...", "按标签排序…"), ("Sort by...", "排序依据…"),
    ("Sort categories by name", "按名称排分类"), ("Sort tracks by name", "按名称排轨道"),
    ("Sort...", "排序…"), ("Spreadsheet view", "表格视图"), ("Square view", "方形视图"),
    ("Square view - same bp per pixel", "方形视图 - 相同 bp/像素"),
    ("Step size of sliding window (bp)", "滑动窗口步长（bp）"), ("Strand", "链"),
    ("Subfeature labels", "子特征标签"), ("Summary score mode", "汇总分数模式"),
    ("Super-compact", "超紧凑"), ("Supplementary/split", "补充/拆分"),
    ("Synteny track selectors", "共线性轨道选择器"), ("T", "T"), ("Target assembly", "目标组装"),
    ("Theme", "主题"), ("Thin", "细"), ("Toggle highlights", "切换高亮"), ("Toggle labels", "切换标签"),
    ("Tools", "工具"), ("Track actions", "轨道操作"), ("Track label positioning", "轨道标签位置"),
    ("Track labels", "轨道标签"), ("Track name", "轨道名称"), ("Track order", "轨道顺序"),
    ("Track type", "轨道类型"), ("Tracks", "轨道"), ("Triangular", "三角"),
    ("Turn off bookmark highlights", "关闭书签高亮"), ("Turn on/off connections...", "开启/关闭连接…"),
    ("Type", "类型"), ("URL", "地址"), ("Undo", "撤销"), ("Unmapped mate", "未比对上的配对端"),
    ("Unphased", "未定相"),
    ("Use CIGAR string to navigate the current visible to the target", "使用 CIGAR 字符串定位到目标"),
    ("Use genomic positions for cell sizes", "使用基因组位置计算单元格大小"),
    ("Use log scale", "使用对数刻度"), ("Use workspaces", "使用工作区"),
    ("Use workspaces (tabbed/tiled view layout)", "使用工作区（标签/平铺视图布局）"),
    ("Username", "用户名"), ("Variant labels", "变异标签"), ("Vertical guides on hover", "悬停时显示垂直参考线"),
    ("View options", "视图选项"), ("Viridis", "Viridis"), ("Wheel scroll mode", "滚轮滚动模式"),
    ("Window size (bp)", "窗口大小（bp）"), ("Zoom in", "放大"), ("Zoom to base level", "缩放到碱基层级"),
    ("Zoom to feature", "缩放到特征"), ("Zoom to region", "缩放到区域"),
    ("Zoom to region(s)", "缩放到区域"), ("Zoom view", "缩放视图"), ("connectionType", "连接类型"),
    ("keep typing for more results", "继续输入以获取更多结果"), ("object", "对象"),
    ("show only regions with data", "仅显示有数据的区域"), ("string", "字符串"),
]


# 除 label:"..." 之外，JBrowse 4 的顶栏按钮与 dojo 根菜单名使用其它字面量形式：
#   children:"Share" / title:"Help"   —— MUI 按钮与对话框标题
#   appendToMenu("Tools") / appendToSubMenu(["Add"]) —— dojo 根菜单名（顶栏菜单按钮显示的就是它）
LITERAL_PAIRS: list[tuple[str, str]] = [
    ('children:"Add"', 'children:"添加"'),
    ('children:"Tools"', 'children:"工具"'),
    ('children:"Help"', 'children:"帮助"'),
    ('children:"Share"', 'children:"共享"'),
    ('children:"File"', 'children:"文件"'),
    ('children:"Next"', 'children:"下一步"'),
    ('children:"Cancel"', 'children:"取消"'),
    ('children:"OK"', 'children:"确定"'),
    ('children:"Close"', 'children:"关闭"'),
    ('title:"Add"', 'title:"添加"'),
    ('title:"Tools"', 'title:"工具"'),
    ('title:"Help"', 'title:"帮助"'),
    ('title:"Share"', 'title:"共享"'),
    ('title:"File"', 'title:"文件"'),
    ('appendToMenu("File"', 'appendToMenu("文件"'),
    ('appendToMenu("Add"', 'appendToMenu("添加"'),
    ('appendToMenu("Tools"', 'appendToMenu("工具"'),
    ('appendToMenu("Help"', 'appendToMenu("帮助"'),
    ('appendToMenu("Share"', 'appendToMenu("共享"'),
    ('appendToSubMenu(["Add"]', 'appendToSubMenu(["添加"]'),
    ('appendToSubMenu(["File"]', 'appendToSubMenu(["文件"]'),
    ('appendToSubMenu(["Tools"]', 'appendToSubMenu(["工具"]'),
    ('appendToSubMenu(["Help"]', 'appendToSubMenu(["帮助"]'),
    ('appendToSubMenu(["Share"]', 'appendToSubMenu(["共享"]'),
    ('? "Add":"Next"', '? "添加":"下一步"'),
    ('===te.length-1?"Add":"Next"', '===te.length-1?"添加":"下一步"'),
]


def _targets() -> list[Path]:
    return [p for p in sorted(JS_DIR.glob("*.js")) if not p.name.endswith(".js.map")]


def apply_patch() -> int:
    changed_files = 0
    replaced = 0
    for path in _targets():
        text = path.read_text(encoding="utf-8")
        original = text
        for en, zh in PAIRS:
            needle = f'label:"{en}"'
            if needle in text:
                replaced += text.count(needle)
                text = text.replace(needle, f'label:"{zh}"')
        for needle, target in LITERAL_PAIRS:
            if needle in text:
                replaced += text.count(needle)
                text = text.replace(needle, target)
        if text != original:
            path.write_text(text, encoding="utf-8")
            changed_files += 1
    print(f"已处理 {changed_files} 个 bundle，共替换 {replaced} 处文案")
    return replaced


def backup() -> None:
    if BACKUP_DIR.exists():
        print(f"备份已存在，跳过：{BACKUP_DIR}")
        return
    shutil.copytree(JS_DIR, BACKUP_DIR)
    print(f"已备份到 {BACKUP_DIR}")


def restore() -> None:
    if not BACKUP_DIR.exists():
        print("没有可用备份", file=sys.stderr)
        return
    for path in _targets():
        src = BACKUP_DIR / path.name
        if src.exists():
            shutil.copy2(src, path)
    print("已从备份还原")


def check() -> None:
    total = 0
    for path in _targets():
        text = path.read_text(encoding="utf-8")
        for en, zh in PAIRS:
            if f'label:"{en}"' in text:
                total += 1
        for needle, _ in LITERAL_PAIRS:
            if needle in text:
                total += 1
    print(f"仍有 {total} 处英文文案未替换")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--restore", action="store_true")
    args = ap.parse_args()
    if args.restore:
        restore()
    elif args.check:
        check()
    else:
        backup()
        apply_patch()


if __name__ == "__main__":
    main()
