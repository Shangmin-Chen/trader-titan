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
      </dl>
    </article>
  );
}
