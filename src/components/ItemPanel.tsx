import {
  formatPreciseNumber,
  type PublicGeneratedItem,
  type SettledGeneratedItem,
} from "../lib/game";

export type ItemPanelProps = {
  item: PublicGeneratedItem | SettledGeneratedItem;
  revealTrueValue?: boolean;
};

export function ItemPanel({ item, revealTrueValue = false }: ItemPanelProps) {
  const trueValue =
    revealTrueValue && "true_value" in item && typeof item.true_value === "number"
      ? item.true_value
      : null;

  const scrapedItems =
    revealTrueValue && "scraped_items" in item && Array.isArray(item.scraped_items)
      ? item.scraped_items
      : null;

  const amazonUrl =
    revealTrueValue && "amazon_url" in item && typeof item.amazon_url === "string"
      ? item.amazon_url
      : null;

  return (
    <article className="item-panel" data-testid="item-panel">
      <header className="item-panel__header">
        <p className="item-panel__category">{item.category}</p>
        <h2 className="item-panel__title">{item.item_title}</h2>
      </header>

      <dl className="item-panel__details">
        <div className="item-panel__detail">
          <dt>Context</dt>
          <dd>{item.context_clue}</dd>
        </div>

        {trueValue !== null ? (
          <div className="item-panel__detail">
            <dt>True value</dt>
            <dd>{formatPreciseNumber(trueValue)}</dd>
          </div>
        ) : null}

        {amazonUrl ? (
          <div className="item-panel__detail">
            <dt>Amazon Source Link</dt>
            <dd>
              <a
                href={amazonUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="amazon-link"
              >
                View Search on Amazon
              </a>
            </dd>
          </div>
        ) : null}

        {scrapedItems && scrapedItems.length > 0 ? (
          <div className="item-panel__detail" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <dt>Scraped Listings (First Is Source Of Truth)</dt>
            <dd>
              <ul className="scraped-items-list">
                {scrapedItems.map((scraped, i) => (
                  <li key={i} className={i === 0 ? "source-of-truth" : ""}>
                    <span className="scraped-item-title" title={scraped.title}>
                      {scraped.title}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className="scraped-item-price">
                        ${formatPreciseNumber(scraped.price)}
                      </span>
                      {i === 0 && <span className="source-badge">Source of Truth</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}
