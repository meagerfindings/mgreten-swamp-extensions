"""Markdown-blog parser helper. Reads JSON stdin; emits only public content."""

import json
import platform
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urlsplit


def render(source):
    import markdown
    import yaml
    from markdown.extensions.fenced_code import FencedCodeExtension
    from markdown.extensions.tables import TableExtension
    from markdown.extensions.toc import TocExtension, slugify

    versions = {"markdown": markdown.__version__, "yaml": yaml.__version__}
    if versions != {"markdown": "3.3.6", "yaml": "5.4.1"}:
        raise ValueError(
            "Expected Python-Markdown 3.3.6 and PyYAML 5.4.1; found "
            + json.dumps(versions, sort_keys=True)
            + ". Use the reviewed renderer environment; dependencies are never installed automatically."
        )

    class FrontmatterLoader(yaml.SafeLoader):
        def compose_node(self, parent, index):
            if self.check_event(yaml.AliasEvent):
                raise ValueError("YAML aliases are not supported in blog frontmatter")
            return super().compose_node(parent, index)

        def construct_mapping(self, node, deep=False):
            result = {}
            for key_node, value_node in node.value:
                key = self.construct_object(key_node, deep=deep)
                if not isinstance(key, str) or key == "<<":
                    raise ValueError("Frontmatter keys must be strings; YAML merges are not supported")
                if key in result:
                    raise ValueError("Duplicate frontmatter key")
                result[key] = self.construct_object(value_node, deep=deep)
            return result

    FrontmatterLoader.add_constructor(
        "tag:yaml.org,2002:timestamp", FrontmatterLoader.construct_scalar
    )
    source = source.replace("\r\n", "\n")
    match = re.match(r"\A---\n(.*?)\n---(?:\n|$)", source, re.DOTALL)
    if not match:
        raise ValueError("Markdown must begin with YAML frontmatter between --- lines")
    try:
        metadata = yaml.load(match.group(1), Loader=FrontmatterLoader)
    except yaml.YAMLError:
        # YAML exceptions can include private source excerpts.
        raise ValueError("Invalid YAML frontmatter") from None
    if not isinstance(metadata, dict):
        raise ValueError("Frontmatter must be a mapping")

    start = "<!-- blog:content:start -->"
    end = "<!-- blog:content:end -->"
    remainder = source[match.end():]
    if remainder.count(start) != 1 or remainder.count(end) != 1:
        raise ValueError("Require exactly one blog:content:start and blog:content:end marker")
    lines = remainder.splitlines()
    if start not in lines or end not in lines:
        raise ValueError("Content markers must be on their own lines")
    first, last = lines.index(start), lines.index(end)
    body = "\n".join(lines[first + 1:last]).strip()
    if last <= first or not body:
        raise ValueError("Content markers must be ordered around a nonempty article")

    md = markdown.Markdown(
        extensions=[
            FencedCodeExtension(),
            TableExtension(),
            TocExtension(marker="", slugify=lambda value, separator: "section-" + slugify(value, separator)),
        ],
        output_format="html",
    )
    # Escape source HTML, but retain the postprocessor used for generated fences.
    md.preprocessors.deregister("html_block")
    md.inlinePatterns.deregister("html")
    # Use this pinned parser's fence recognizer, not a second Markdown grammar.
    # Its brace attributes bypass normal escaping; some are silently dropped.
    fence_pattern = md.preprocessors["fenced_code_block"].FENCED_BLOCK_RE
    for fence in fence_pattern.finditer(body):
        if fence.group("attrs") or not re.fullmatch(r"[A-Za-z0-9_-]*", fence.group("lang") or ""):
            raise ValueError("Use simple fenced-code language names, without brace attributes")
    html_body = md.convert(body).replace('class="language-diagram"', 'class="language-text"')
    validate_html(html_body)
    # Only publication metadata crosses the subprocess boundary. Private fields
    # and everything outside the explicit content markers are discarded.
    fields = ("title", "date", "slug", "excerpt", "series", "seriesOrder")
    return {
        "metadata": {key: metadata[key] for key in fields if key in metadata},
        "htmlBody": html_body,
        "renderer": "Python " + platform.python_version() + " / Python-Markdown 3.3.6 / PyYAML 5.4.1 / markdown-blog-v1",
    }


class PublicationHTML(HTMLParser):
    """Validate final HTML, including fenced-code HTML restored after the AST."""

    tags = {
        "p", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li",
        "strong", "em", "a", "img", "pre", "code", "br", "hr", "table",
        "thead", "tbody", "tr", "th", "td",
    }
    attributes = {
        "a": {"href", "title"}, "img": {"src", "alt", "title"},
        "code": {"class"}, "ol": {"start"}, "th": {"align"}, "td": {"align"},
        **{tag: {"id"} for tag in ("h2", "h3", "h4", "h5", "h6")},
    }
    blocks = {"p", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.code_depth = 0
        self.prose = []

    def check_prose(self):
        text = "".join(self.prose)
        self.prose.clear()
        if re.search(r"\[\[|\]\]|%%|\[![A-Za-z]|<!--", text):
            raise ValueError(
                "Resolve Obsidian links, embeds, comments, and callouts in the public body; "
                "put examples inside code and private notes outside the content markers"
            )

    def handle_starttag(self, tag, attrs):
        if tag not in self.tags:
            raise ValueError("Unsupported generated HTML tag; use Markdown headings starting at ##")
        if tag in self.blocks or tag in {"pre", "code"}:
            self.check_prose()
        if tag in {"pre", "code"}:
            self.code_depth += 1
        names = set()
        for name, value in attrs:
            if name in names or name not in self.attributes.get(tag, set()) or value is None:
                raise ValueError("Unsupported generated HTML attribute; use simple fenced-code language names")
            names.add(name)
            if name in {"href", "src"}:
                self.check_url(value, image=name == "src")
            elif name == "class" and not re.fullmatch(r"language-[A-Za-z0-9_-]+", value):
                raise ValueError("Use a simple fenced-code language name, without attributes")
            elif name == "id" and not re.fullmatch(r"section-[a-z0-9_-]*", value):
                raise ValueError("Invalid generated heading ID")
            elif name == "align" and value not in {"left", "center", "right"}:
                raise ValueError("Invalid table alignment")
            elif name == "start" and not value.isdigit():
                raise ValueError("Invalid ordered-list start")
            elif name in {"alt", "title"}:
                self.prose.append(value)
                self.check_prose()

    def handle_endtag(self, tag):
        if tag not in self.tags:
            raise ValueError("Unsupported generated HTML closing tag")
        if tag in {"pre", "code"}:
            self.code_depth -= 1
        if tag in self.blocks:
            self.check_prose()

    def handle_data(self, text):
        if not self.code_depth:
            self.prose.append(text)

    def handle_comment(self, data):
        raise ValueError("HTML comments are not allowed in the public article")

    def handle_decl(self, decl):
        raise ValueError("HTML declarations are not allowed in the public article")

    @staticmethod
    def check_url(value, image):
        if value != value.strip() or any(ord(c) < 32 for c in value) or "\\" in value:
            raise ValueError("Invalid public URL")
        url = urlsplit(value)
        if value.startswith("//") or url.username or url.password:
            raise ValueError("Protocol-relative URLs and URL credentials are not allowed")
        if url.scheme in {"https", "http"} and url.hostname:
            return
        if not image and url.scheme == "mailto" and url.path:
            return
        if not url.scheme and not url.netloc:
            if value.startswith("/") and not re.search(r"\.(md|canvas)(?:$|[?#])", value, re.I):
                return
            if not image and value.startswith("#"):
                return
        raise ValueError("Use public HTTP(S), root-relative site URLs, or link fragments; resolve local note links first")


def validate_html(value):
    parser = PublicationHTML()
    parser.feed(value)
    parser.close()
    parser.check_prose()


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(render(payload["source"]), ensure_ascii=False))
    except ImportError:
        print("Renderer requires Python-Markdown 3.3.6 and PyYAML 5.4.1 in python3", file=sys.stderr)
        sys.exit(1)
    except (ValueError, TypeError, KeyError):
        # Our validation errors contain rules, never source excerpts.
        error = sys.exc_info()[1]
        print(str(error) if isinstance(error, ValueError) else "Invalid Markdown input", file=sys.stderr)
        sys.exit(1)
