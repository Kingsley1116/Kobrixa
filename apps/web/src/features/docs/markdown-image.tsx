import "./styles/prose.css";

const docsImageBase = "https://raw.githubusercontent.com/Kingsley1116/Kobrixa/main/docs/images/";

/** Repository-relative `../images/x.png` paths do not exist on the site, so serve them from GitHub. */
function resolveImageSource(src: string | undefined): string | undefined {
  const match = src ? /^(?:\.\.\/)*images\/(.+)$/.exec(src) : null;
  return match ? `${docsImageBase}${match[1]}` : src;
}

type MarkdownImageProps = {
  src?: string | undefined;
  alt?: string | undefined;
  title?: string | undefined;
};

/**
 * Markdown images sit inside paragraphs, so the figure is built from spans with
 * `role="figure"` instead of `<figure>`/`<figcaption>`, which may not nest in `<p>`.
 */
export function MarkdownImage({ src, alt, title }: MarkdownImageProps) {
  const image = (
    <img
      className="prose-image"
      src={resolveImageSource(src)}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
    />
  );
  if (!title) return image;
  return (
    <span className="prose-figure" role="figure" aria-label={title}>
      {image}
      <span className="prose-figcaption" aria-hidden="true">
        {title}
      </span>
    </span>
  );
}
