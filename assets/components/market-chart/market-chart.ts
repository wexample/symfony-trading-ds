import Component from '@wexample/symfony-loader/js/Class/Component';
import LazyActivationMixin from '@wexample/symfony-loader/js/Class/Mixins/LazyActivationMixin';
import { AssetsServiceEvents } from '@wexample/symfony-loader/js/Services/AssetsService';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

type MarketChartOptions = {
  // The market chart its layers are read as, from symfony-trading's endpoints.
  source: string;
  // What the chart is about, by its id, for the provider.
  scope: string | null;
  lazy: boolean;
  // The events of the page after which its layers are read again.
  refresh: string[];
};

type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

type Marker = { time: UTCTimestamp; side: 'buy' | 'sell'; price: number; pnl: number | null; label: string | null };

type Series = { key: string; name: string; pane: number; color: string | null; points: { time: UTCTimestamp; value: number }[] };

type Layers = { candles: Candle[]; markers: Marker[]; series: Series[] };

// The roles of the design system, read where the chart is drawn so that a
// colour scheme reaches it as it reaches the rest of the page.
type MarketChartTheme = {
  text: string;
  line: string;
  surface: string;
  font: string;
  accent: string;
  up: string;
  down: string;
};

// The share of the height the candles keep when series are drawn beneath them.
const PRICE_PANE_STRETCH = 0.7;

export default class extends Component {
  // Given by market_chart() (MarketChartExtension), merged in by the loader.
  declare public options: MarketChartOptions;
  private chart?: IChartApi;
  private candleSeries?: ISeriesApi<'Candlestick'>;
  private markers?: ISeriesMarkersPluginApi<Time>;
  private lines: ISeriesApi<'Line'>[] = [];
  private layers: Layers = { candles: [], markers: [], series: [] };
  private words: Record<'buy' | 'sell', string> = { buy: 'Buy', sell: 'Sell' };

  // A chart is a library to start: it waits to be seen (`lazy: false` on a
  // call to draw it at once, at the top of a page).
  async init() {
    LazyActivationMixin.apply(this);
    await super.init();
  }

  protected async activateListeners(): Promise<void> {
    await super.activateListeners();

    const canvas = this.canvas();

    if (!canvas) {
      return;
    }

    this.words = { ...this.words, ...JSON.parse(canvas.dataset.words || '{}') };
    // Sized by the canvas, which CSS sizes: followed as it changes.
    this.chart = createChart(canvas, { autoSize: true });
    // A colour scheme, a palette or a skin switched: drawn again in its colours.
    this.app.services.events.listen(AssetsServiceEvents.USAGE_CHANGE, this.onUsageChange);
    this.options.refresh?.forEach((event) => this.app.services.events.listen(event, this.onRefresh));

    // Not awaited: a slow answer would hold the activation of the component.
    void this.read().then(() => this.draw(true));
  }

  protected async deactivateListeners(): Promise<void> {
    this.app.services.events.forget(AssetsServiceEvents.USAGE_CHANGE, this.onUsageChange);
    this.options.refresh?.forEach((event) => this.app.services.events.forget(event, this.onRefresh));
    this.chart?.remove();
    this.chart = undefined;
    this.candleSeries = undefined;
    this.markers = undefined;
    this.lines = [];

    await super.deactivateListeners();
  }

  private onUsageChange = (): void => {
    this.draw(false);
  };

  // Read again in place: what is drawn stays until the new layers come, and
  // the range looked at is kept.
  private onRefresh = (): void => {
    void this.read().then(() => this.draw(false));
  };

  private canvas(): HTMLElement | null {
    return this.el.querySelector<HTMLElement>('.market-chart--canvas');
  }

  // The three layers, read as any list of entities is read: through the
  // repositories generated from Candle, TradeMarker and TimeSeriesPoint,
  // which know their endpoints. A failure is thrown, not drawn as an empty
  // chart.
  private async read(): Promise<void> {
    const client = (this.app.getService('api') as any).client;
    const query = { chart: this.options.source, ...(this.options.scope ? { scope: this.options.scope } : {}) };
    const [candles, markers, points] = await Promise.all(
      ['candle', 'tradeMarker', 'timeSeriesPoint'].map((name) => client.getRepository(name).fetchList({ query }) as Promise<any[]>)
    );
    const read = (entity: any, name: string) => entity.getDataValue(name);

    this.layers = {
      candles: ascending(candles.map((candle) => ({
        time: read(candle, 'time') as UTCTimestamp,
        open: read(candle, 'open'),
        high: read(candle, 'high'),
        low: read(candle, 'low'),
        close: read(candle, 'close'),
      }))),
      markers: markers
        .map((marker) => ({
          time: read(marker, 'time') as UTCTimestamp,
          side: read(marker, 'side'),
          price: read(marker, 'price'),
          pnl: read(marker, 'pnl') ?? null,
          label: read(marker, 'label') ?? null,
        }))
        .sort((first, second) => first.time - second.time),
      series: this.seriesOf(points),
    };
  }

  // Points to series: one per key, with its label, pane and colour, its
  // values in time order and without their gaps.
  private seriesOf(points: any[]): Series[] {
    const read = (entity: any, name: string) => entity.getDataValue(name);
    const series = new Map<string, Series>();

    points.forEach((point) => {
      const key = read(point, 'series') as string;

      if (!series.has(key)) {
        series.set(key, {
          key,
          name: read(point, 'seriesLabel') ?? key,
          pane: read(point, 'pane') ?? 0,
          color: read(point, 'color') ?? null,
          points: [],
        });
      }

      const value = read(point, 'value');

      if (value !== null && value !== undefined) {
        series.get(key)!.points.push({ time: read(point, 'time') as UTCTimestamp, value });
      }
    });

    return [...series.values()].map((item) => ({ ...item, points: ascending(item.points) }));
  }

  // `fit`: the whole of the candles shown, on the first drawing; afterwards
  // the range looked at stays where it was.
  private draw(fit: boolean): void {
    if (!this.chart) {
      return;
    }

    const empty = this.el.querySelector<HTMLElement>('.market-chart--empty');
    const canvas = this.canvas();
    const nothing = this.layers.candles.length === 0;

    if (empty && canvas) {
      empty.hidden = !nothing;
      canvas.hidden = nothing;
    }

    if (nothing) {
      return;
    }

    const theme = this.theme();
    this.chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: theme.surface },
        textColor: theme.text,
        fontFamily: theme.font,
        panes: { separatorColor: theme.line, separatorHoverColor: theme.line },
      },
      grid: { vertLines: { color: theme.line }, horzLines: { color: theme.line } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: theme.line },
      timeScale: { borderColor: theme.line, timeVisible: true, secondsVisible: false },
    });

    this.drawCandles(theme);
    this.drawSeries(theme);

    if (fit) {
      this.chart.timeScale().fitContent();
    }
  }

  private drawCandles(theme: MarketChartTheme): void {
    this.candleSeries ??= this.chart!.addSeries(CandlestickSeries, {}, 0);
    this.candleSeries.applyOptions({
      upColor: theme.up,
      downColor: theme.down,
      borderVisible: false,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
    });
    this.candleSeries.setData(this.layers.candles);

    // A buy below its candle pointing up, a sell above it pointing down; one
    // closing a trade coloured by what the trade made.
    const markers: SeriesMarker<Time>[] = this.layers.markers.map((marker) => ({
      time: marker.time,
      position: marker.side === 'buy' ? 'belowBar' : 'aboveBar',
      shape: marker.side === 'buy' ? 'arrowUp' : 'arrowDown',
      color: marker.pnl === null ? theme.accent : (marker.pnl >= 0 ? theme.up : theme.down),
      text: marker.label ?? this.words[marker.side],
    }));

    if (this.markers) {
      this.markers.setMarkers(markers);
    } else {
      this.markers = createSeriesMarkers(this.candleSeries, markers);
    }
  }

  // The series drawn along, drawn again whole: few, and their panes may change.
  private drawSeries(theme: MarketChartTheme): void {
    this.lines.forEach((line) => this.chart!.removeSeries(line));
    this.lines = this.layers.series.map((item) => {
      const line = this.chart!.addSeries(LineSeries, {
        color: item.color ? this.categoryColor(item.color, theme) : theme.accent,
        lineWidth: 2,
        priceLineVisible: false,
        title: item.name,
      }, item.pane);
      line.setData(item.points);

      return line;
    });

    // The candles keep most of the height; the panes beneath share the rest.
    const panes = this.chart!.panes();

    if (panes.length > 1) {
      panes[0].setStretchFactor(PRICE_PANE_STRETCH);
      panes.slice(1).forEach((pane) => pane.setStretchFactor((1 - PRICE_PANE_STRETCH) / (panes.length - 1)));
    }

    this.writeLegend(theme);
  }

  private writeLegend(theme: MarketChartTheme): void {
    const legend = this.el.querySelector<HTMLElement>('.market-chart--legend');

    if (!legend) {
      return;
    }

    legend.replaceChildren(...this.layers.series.map((item) => {
      const entry = document.createElement('li');
      entry.className = 'market-chart--legend-item';
      entry.style.setProperty('--market-chart-series-color', item.color ? this.categoryColor(item.color, theme) : theme.accent);
      entry.textContent = item.name;

      return entry;
    }));
    legend.hidden = this.layers.series.length === 0;
  }

  private theme(): MarketChartTheme {
    const style = getComputedStyle(this.el);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;

    return {
      text: read('--text-color-muted', '#666666'),
      line: read('--border-color-discreet', '#e5e5e5'),
      surface: read('--surface-3', '#ffffff'),
      font: read('--font-family-base', 'sans-serif'),
      accent: read('--accent-9', '#6366f1'),
      up: read('--success-9', '#22c55e'),
      down: read('--error-9', '#ef4444'),
    };
  }

  private categoryColor(name: string, theme: MarketChartTheme): string {
    return getComputedStyle(this.el).getPropertyValue(`--cat-${name}-9`).trim() || theme.accent;
  }
}

// In strictly increasing time, as Lightweight Charts requires: the last of
// two values at the same time kept.
function ascending<T extends { time: UTCTimestamp }>(items: T[]): T[] {
  const byTime = new Map<number, T>();
  items.forEach((item) => byTime.set(item.time, item));

  return [...byTime.values()].sort((first, second) => first.time - second.time);
}
