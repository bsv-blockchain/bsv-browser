# Perf bench — baseline vs improved

Baseline at: 2026-05-21T04:09:53.903Z
Improved at: 2026-05-21T04:14:48.553Z

+-----------------------------------------------------+------------------+------------------+----------------+
| Metric                                              | Baseline         | Improved         | Δ              |
+-----------------------------------------------------+------------------+------------------+----------------+
| console.log x10k (typical dApp logging)             | 4,607,233 ops/s  | 16,525,511 ops/s | 3.59x          |
| console.bridge_calls_for_10k_mixed                  | 10,330           | 1,030            | 10.03x fewer   |
| provider.consumer_rerenders_for_1000_parent_renders | 1,000            | 1                | 1000.00x fewer |
| provider.value_construction x1000                   | 26,402,640 ops/s | 32,000,000 ops/s | 1.21x          |
| bookmark.root_renders_for_500_mutations             | 501              | 1                | 501.00x fewer  |
| bookmark.isolated_renders_for_500_mutations         | 0                | 501              | 0.00x fewer    |
| bookmark.add+react x500                             | 76 ops/s         | 80 ops/s         | 1.05x          |
| tab.count_after_50_opens                            | 50               | 8                | 6.25x fewer    |
| wallet.value_rebuild x1000                          | 4,964,849 ops/s  | 5,148,005 ops/s  | 1.04x          |
| thumbnail.schedule x500 (every onLoadEnd)           | 2,581,205 ops/s  | 2,617,226 ops/s  | 1.01x          |
| thumbnail.schedule_gated x500                       | 17,991,436 ops/s | 17,021,277 ops/s | 0.95x          |
+-----------------------------------------------------+------------------+------------------+----------------+
