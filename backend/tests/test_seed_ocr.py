"""种子标签 OCR 的解析层测试。

不测 tesseract 本身的识别率（那是环境/图像质量问题，机器相关），
只测"给定 OCR 文本 → 字段"这一段纯逻辑，它才是我们自己的代码。
"""

from app.seed_ocr import parse_label


def test_parses_labelled_lines():
    text = "D509 种子库\n品种：水稻 中花11\n编号：ZH11-2026-041\n数量：250 粒\n位置：冷库A 3层\n负责人：陈同学\n"
    out = parse_label(text)
    assert out["fields"]["code"] == "ZH11-2026-041"
    assert out["fields"]["quantity"] == "250"  # 单位被剥掉
    assert "水稻" in out["fields"]["variety"]
    assert out["matched"] >= 4


def test_quantity_without_digits_is_dropped():
    """数量行只认出单位、没有数字时不能塞一个 "粒" 进数量字段。"""
    out = parse_label("数量：粒\n编号：A-12")
    assert "quantity" not in out["fields"]


def test_falls_back_to_code_when_no_labels():
    """整张标签没有"品种："这类前缀时，退化成把编号行当 code。"""
    out = parse_label("D509\nABC-2026041\n")
    assert out["fields"]["code"] == "ABC-2026041"


def test_noise_lines_are_ignored():
    out = parse_label("||||\n~~~~\n品种：大豆\n")
    assert out["fields"] == {"variety": "大豆"}
    assert out["lines"] == ["品种：大豆"]  # 全角冒号保留，前缀在取值时才剥


def test_empty_text_yields_nothing():
    out = parse_label("")
    assert out["fields"] == {}
    assert out["matched"] == 0
