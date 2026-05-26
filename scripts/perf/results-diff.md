# Perf bench — baseline vs improved

Baseline at: 2026-05-21T18:43:46.697Z
Improved at: 2026-05-21T18:43:34.553Z

## Label diff (baseline run vs improved run)

+-----------------------------------------------------+-------------------+------------------+----------------+
| Metric                                              | Baseline          | Improved         | Δ              |
+-----------------------------------------------------+-------------------+------------------+----------------+
| console.log x10k (typical dApp logging)             | 4,246,961 ops/s   | 12,135,922 ops/s | 2.86x          |
| console.bridge_calls_for_10k_mixed                  | 10,330            | 1,030            | 10.03x fewer   |
| provider.consumer_rerenders_for_1000_parent_renders | 1,000             | 1                | 1000.00x fewer |
| provider.value_construction x1000                   | 25,396,825 ops/s  | 5,155,755 ops/s  | 0.20x          |
| bookmark.root_renders_for_500_mutations             | 501               | 1                | 501.00x fewer  |
| bookmark.isolated_renders_for_500_mutations         | 0                 | 501              | 0.00x fewer    |
| bookmark.add+react x500                             | 71 ops/s          | 61 ops/s         | 0.86x          |
| tab.count_after_50_opens                            | 50                | 8                | 6.25x fewer    |
| wallet.value_rebuild x1000                          | 4,599,456 ops/s   | 4,032,258 ops/s  | 0.88x          |
| thumbnail.schedule x500 (every onLoadEnd)           | 2,531,646 ops/s   | 1,373,155 ops/s  | 0.54x          |
| thumbnail.schedule_gated x500                       | 18,376,273 ops/s  | 15,894,208 ops/s | 0.86x          |
| suggestions.sync_search_50keystrokes                | 52,605 ops/s      | 49,815 ops/s     | 0.95x          |
| suggestions.deferred_search_50keystrokes            | 2,647,842 ops/s   | 2,595,717 ops/s  | 0.98x          |
| list.measure_each_x200                              | 523,218 ops/s     | 485,584 ops/s    | 0.93x          |
| list.getItemLayout_x200                             | 119,976,005 ops/s | 97,943,193 ops/s | 0.82x          |
+-----------------------------------------------------+-------------------+------------------+----------------+

## Head-to-head (single-run, slow path vs fast path)

+-------------------------------------------------------+-----------------+------------------+---------------+
| Scenario                                              | Slow path       | Fast path        | Δ             |
+-------------------------------------------------------+-----------------+------------------+---------------+
| Address bar typing — Fuse search cost (50 keystrokes) | 49,815 ops/s    | 2,595,717 ops/s  | 52.1x faster  |
| FlatList row layout — 200 rows                        | 485,584 ops/s   | 97,943,193 ops/s | 201.7x faster |
| Thumbnail scheduling — onLoadEnd cost                 | 1,373,155 ops/s | 15,894,208 ops/s | 11.6x faster  |
+-------------------------------------------------------+-----------------+------------------+---------------+
