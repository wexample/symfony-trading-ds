<?php

namespace Wexample\SymfonyTradingDs\Twig;

use Twig\Environment;
use Twig\TwigFunction;
use Wexample\SymfonyDesignSystem\Twig\AbstractTemplateExtension;

/**
 * - `market_chart(source, { scope, timeframe, title, label, height, lazy, refresh })`: a
 *   market's candles drawn by Lightweight Charts, the trades marked on them
 *   and the series drawn along, all three read from the api as the layers of
 *   the market chart `source` (symfony-trading's MarketChartProviderInterface).
 */
class MarketChartExtension extends AbstractTemplateExtension
{
    public function getFunctions(): array
    {
        return [
            new TwigFunction(
                'market_chart',
                function (
                    Environment $twig,
                    $context,
                    string $source,
                    array $options = []
                ): string {
                    return $this->renderComponent(
                        $twig,
                        $context,
                        '@WexampleSymfonyTradingDsBundle/components/market-chart',
                        [
                            'height' => $options['height'] ?? null,
                            // The card it stands in, titled so; none without it.
                            'title' => $options['title'] ?? null,
                            'label' => $options['label'] ?? $options['title'] ?? null,
                            'class' => $options['class'] ?? null,
                        ],
                        [
                            'source' => $source,
                            // What the chart is about, by its id, for the provider.
                            'scope' => isset($options['scope']) ? (string) $options['scope'] : null,
                            // The width of its candles, for a provider offering several.
                            'timeframe' => $options['timeframe'] ?? null,
                            // False to draw at once rather than when scrolled to.
                            'lazy' => (bool) ($options['lazy'] ?? true),
                            // The events of the page after which its layers are read again.
                            'refresh' => array_values((array) ($options['refresh'] ?? [])),
                        ]
                    );
                },
                self::TEMPLATE_FUNCTION_OPTIONS
            ),
        ];
    }
}
