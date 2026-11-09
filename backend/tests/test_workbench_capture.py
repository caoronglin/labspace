"""工作台本地规则捕获：类型判定优先级与日期抽取。"""
from __future__ import annotations

from datetime import date

import pytest

from app.workbench import analyze_capture

TODAY = date(2026, 11, 4)  # 周三


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("记住：审稿意见要逐条回复", "memory"),
        ("以后写论文先列大纲", "memory"),
        ("目标是三个月内发一篇论文", "plan"),
        ("下周三前完成论文修改", "task"),
        ("这个项目下月结题", "project"),
        ("想法：可以试试用 RNA-seq 验证", "idea"),
        ("文献 #综述 参考一下", "knowledge"),
        ("随便写点什么", "note"),
    ],
)
def test_kind_priority(text: str, kind: str) -> None:
    assert analyze_capture(text, today=TODAY)["kind"] == kind


def test_memory_is_not_shadowed_by_task_verbs() -> None:
    """"记住" 曾同时出现在 task 与 memory 规则里，导致 memory 永远不会命中。"""
    result = analyze_capture("记住：审稿意见要逐条回复", today=TODAY)
    assert result["kind"] == "memory"
    assert "记住" in result["ai_reason"]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("2026-12-01 交初稿", date(2026, 12, 1)),
        ("3天后核对数据", date(2026, 11, 7)),
        ("本周五前回复", date(2026, 11, 6)),
        ("下周二提交", date(2026, 11, 10)),
        ("后天开会", date(2026, 11, 6)),
        ("明天汇报", date(2026, 11, 5)),
    ],
)
def test_due_date(text: str, expected: date) -> None:
    assert analyze_capture(text, today=TODAY)["due_date"] == expected


def test_invalid_iso_date_is_ignored() -> None:
    assert analyze_capture("2026-02-31 提交", today=TODAY)["due_date"] is None


def test_priority_prefers_low_over_high() -> None:
    """"不急" 里含 "急"，必须先判低优先级。"""
    assert analyze_capture("这个不急，有空再看", today=TODAY)["priority"] == "low"
    assert analyze_capture("尽快处理", today=TODAY)["priority"] == "high"


def test_tags_are_deduped_and_capped() -> None:
    text = "#投稿 #投稿 #实验 #数据 #写作 #阅读 #其他"
    tags = analyze_capture(text, today=TODAY)["tags"]
    assert tags[0] == "投稿"
    assert len(tags) <= 5
    assert len(set(tags)) == len(tags)


def test_confidence_is_bounded() -> None:
    for text in ("", "x", "#a #b #c #d 紧急 明天 待办"):
        confidence = analyze_capture(text or " ", today=TODAY)["confidence"]
        assert 0.4 <= confidence <= 0.95
