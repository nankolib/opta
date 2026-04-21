# Opta

## The Options Primitive for Solana

**A Technical Whitepaper**

Version 1.0 — April 2026

---

Opta is a permissionless, any-asset options protocol built on Solana. It introduces the Living Option Token: an option represented as a Token-2022 mint whose on-chain extensions make the token enforce its own expiry, carry its complete term sheet in its metadata, and be burned by the protocol at settlement without custodial intermediation. Opta ships with a three-layer liquidity architecture, on-chain Black-Scholes pricing implemented via a custom solmath library at approximately fifty thousand compute units per quote, and a progressive-decentralisation roadmap from its current devnet deployment to a permissionless mainnet footprint. This document describes the protocol's design, its market thesis, its security posture, and its known limitations.

---

## Table of Contents

1. Executive Summary
2. The Market Thesis
3. Why On-Chain Options Have Not Yet Worked
4. The Living Option Token
5. Architecture
6. Pricing
7. The Three-Layer Liquidity Model
8. Security
9. Current State and Honest Limitations
10. Progressive Decentralisation Roadmap
11. The Fourth Primitive Claim
12. Comparison With Prior Art
13. Conclusion
14. Appendix A — Instruction Set
15. Appendix B — Account Structures
16. Appendix C — References

---

## 1. Executive Summary

The global derivatives market is valued at roughly eight hundred and forty-six trillion dollars in notional outstanding. Of that, options alone represent one hundred and eight billion contracts traded in 2023, compared to twenty-nine billion futures contracts — a four-to-one ratio, rising to nine-to-one in equity index derivatives. Options are the dominant derivative class in mature financial markets, and they play this role for a specific reason: they are the primary instrument for hedging, for structured yield, and for bounded-risk directional exposure. They are how institutional capital insures itself.

Crypto derivatives have developed in the opposite proportion. Perpetual futures — a contract type that does not exist in traditional finance — account for the overwhelming majority of on-chain and off-chain crypto derivatives volume. Options, by comparison, are a thin sliver. This inversion is not a statement about user preference. It is a statement about infrastructure. Perps work on-chain because their settlement is mechanical and their state is simple. Options require four things that have historically been hard to compose: time-dependent expiry enforcement, term-sheet metadata readable by other programs, protocol-controlled settlement without custodianship, and pricing sophisticated enough that professional participants will transact against it. Each of these is individually tractable. Building them together, in a form composable by the rest of DeFi, has not previously been done.

Solana in 2026 is at an unusual inflection point. The perpetual futures market is consolidating elsewhere — Hyperliquid runs its own Layer 1 and handles the overwhelming share of on-chain perp flow. Zeta, long the flagship Solana perp venue, has migrated its core perp product to a dedicated Layer 2 called Bullet. Simultaneously, Solana has quietly become the dominant venue for tokenised real-world assets. BlackRock's BUIDL, Ondo's USDY, Franklin Templeton's BENJI, and a growing roster of tokenised treasuries, equities, and commodities have found their home on Solana because of its settlement speed and fee profile. The Solana Foundation's own ecosystem reporting has highlighted the disproportionate RWA capital parked on the network.

This creates a specific vacuum. There is now billions of dollars of institutional-grade collateral on Solana — and no native on-chain options venue through which that collateral can be hedged or yield-enhanced. The holders of BUIDL, USDY, and similar assets who want options exposure today have to leave Solana entirely, route to Deribit or to over-the-counter desks, and manage the cross-venue capital and operational friction that implies. That is not a user preference. That is revealed behaviour caused by absence of infrastructure.

Opta is built to occupy that vacuum. It is not a better perp venue — that race is over. It is not a retail-facing speculation toy. It is the on-chain options primitive that Solana's institutional RWA capital has been waiting for, built in a composable form so that other protocols, AI agents, and structured-product vaults can use it as a building block.

This whitepaper is organised in three movements. First, it establishes the market thesis — why options dominance is structural in mature markets, why on-chain options have underperformed until now, and why Solana is the specific chain where this primitive is most needed. Second, it describes the protocol architecture in detail — the Living Option Token built on Token-2022, the three-layer liquidity model, the on-chain Black-Scholes pricing engine, and the security story. Third, it is honest about what is not yet finished and what remains on the Phase 2 and mainnet roadmap.

A note on language before proceeding. The protocol was developed under the project name Butter Options and submitted under that name to the Colosseum Frontier hackathon in April 2026. On the twenty-first of April 2026 the project was renamed to Opta to signal the scope evolution from hackathon submission toward mainnet-aspiring infrastructure. Throughout this document, and throughout the public repository and deployment, the project is Opta. Some code-level identifiers in the on-chain programs still reflect the prior name. These are scheduled for renaming in Phase 2 alongside the mainnet redeploy. This is not hidden; it is documented in the repository's seed handoff document and flagged explicitly below.

---

## 2. The Market Thesis

The case for Opta is built on four empirical pillars. Each one is independently verifiable from public data. Taken together, they describe a market gap that is not a matter of opinion but a matter of observable flow.

### 2.1 Options Dominance Is Structural, Not Speculative

In traditional finance, options volume exceeds futures volume by a factor of roughly four to one. This is not a recent anomaly. The Futures Industry Association's 2023 global derivatives volume report recorded approximately one hundred and eight billion options contracts traded versus twenty-nine billion futures contracts — the eleventh consecutive year in which options led. In equity index derivatives specifically, the ratio widens to roughly nine-to-one. Options dominate because mature markets use them for three distinct purposes that futures cannot serve: downside protection with preserved upside, yield generation through premium capture, and bounded-risk directional views.

The implication for crypto is uncomfortable. The current crypto derivatives stack is heavily inverted — perpetual futures dominate, options are marginal. This is not because crypto participants do not want options. It is because the infrastructure to trade options composably on-chain has not existed at a standard that institutional capital will use. The revealed gap is therefore not a demand problem. It is a supply problem. As on-chain infrastructure reaches parity with off-chain venues for options specifically, the default expectation should be that crypto derivatives volume reverts toward the traditional ratio — not overnight, but directionally and decisively.

### 2.2 Institutional Flow Is Already Dominant in On-Chain Derivatives

A common objection is that on-chain derivatives are retail-driven and that institutional framing is overblown. The best publicly available data refutes this directly. Hyperliquid Hub and PANews analysis in early 2026 reported that approximately two hundred wallets account for ninety-eight point eight percent of the roughly four trillion dollars in cumulative trading volume that has passed through Hyperliquid, out of approximately one point seven million total wallets that have interacted with the platform.

This is an extraordinarily concentrated number. Ninety-eight point eight percent of cumulative flow, from zero point zero one percent of wallets. The remaining one point seven million wallets collectively account for just over one percent. The structure is unambiguous: on-chain derivatives flow is already institutional. It is not retail with a long tail of whales. It is professional with a long tail of tourists. Any protocol that wants to be a serious derivatives venue needs to be built for the two hundred wallets that matter, with tooling, capital efficiency, and composability that meet their standards — not for the retail optimism of a previous cycle.

Opta's design is calibrated to this reality. The three-layer liquidity model, the on-chain Black-Scholes pricing, the Token-2022 composability primitive, the planned Pyth-oracle settlement path — these are not retail-feature checklists. They are what institutional flow requires.

### 2.3 Solana Has Lost Perpetuals and Won Real-World Assets

The competitive landscape for on-chain derivatives in 2026 has settled along unexpected lines. Perpetual futures volume has consolidated toward dedicated execution venues: Hyperliquid's own Layer 1 dominates the category globally. Zeta Markets, for years the flagship Solana-native perpetual exchange, announced in 2025 the migration of its core perp product to a dedicated Layer 2 called Bullet, explicitly because the performance envelope of a purpose-built derivatives chain exceeded what any general-purpose Layer 1 could offer for that specific product. Drift remains, but the competitive centre of gravity for perpetuals has left Solana.

Real-world assets have moved in the opposite direction. BlackRock's BUIDL fund, the largest tokenised money-market product in the market, deployed on Solana. Ondo's USDY is natively issued on Solana alongside Ethereum. Franklin Templeton's BENJI operates on Solana. Matrixdock deployed XAUm, Asia's largest tokenised gold product, on Solana in March 2026. Galaxy Digital and Superstate selected Solana for the launch of the GLXY tokenised public equity. The Solana Foundation's own March 2026 ecosystem report emphasised the acceleration of RWA activity on the chain.

These two trends are not coincidence. They reflect Solana's specific architectural strengths — near-instant settlement and negligible fees make it ideal for the kind of high-frequency, large-volume, low-margin activity that tokenised money-market and treasury products require. That same profile is awkward for perpetual futures, which benefit more from purpose-built matching-engine chains.

The strategic implication is clear. Solana in 2026 is not the perp chain. It is the RWA chain. And the RWA chain needs an options primitive, because institutional holders of tokenised assets need to hedge, need to generate yield on their positions, and need to express bounded-risk directional views — and they cannot do any of this natively on Solana today.

### 2.4 Cross-Venue Hedging Is Revealed Preference

The final empirical pillar is the most direct. Institutional holders of Solana-native RWAs today hedge their exposure off-chain. They do this because they have no choice. The flow goes to Deribit for listed options and to over-the-counter desks for structured hedges. Every dollar of this flow is a dollar of capital that must leave the Solana ecosystem, settle on a centralised exchange or a bilateral counterparty, and re-enter Solana when the hedge is unwound — if it ever is. The capital efficiency cost of this round-trip, measured in funding, in operational overhead, and in counterparty risk, is substantial.

This is not theoretical. It is how institutional Solana RWA positions are hedged in practice in 2026. It is revealed preference under constraint. The question Opta poses is straightforward: if the same participants could hedge their Solana-native positions with a Solana-native on-chain options venue — composable with their existing treasury workflows, settling in USDC, priced with a public and auditable Black-Scholes engine — would they? The answer is a trivially yes for any meaningful share of the flow.

Opta does not need to create new demand. The demand exists and is being served by inferior venues today. Opta needs to redirect it.

---

## 3. Why On-Chain Options Have Not Yet Worked

Before describing what Opta does differently, it is worth acknowledging candidly why prior on-chain options protocols have not achieved dominant market position. Opyn, Lyra, Dopex, PsyOptions, the original Zeta options product, Ribbon, Friktion, Premia, Thetanuts — each of these has been serious engineering. None has become the category-defining on-chain options venue. The reasons converge on three structural failures.

### 3.1 Asset-Limited by Default

Most prior on-chain options protocols supported options only on the handful of large-cap crypto assets that had deep oracle coverage — BTC, ETH, SOL, and perhaps a dozen others. This is a significant limitation. It excludes options on tokenised real-world assets, on long-tail crypto tokens, on commodity-backed tokens, and on any asset whose oracle coverage arrived after the protocol's initial market launch. The restriction was rarely architectural. It was usually administrative: each new market required governance action, each new oracle integration required code changes, and the cumulative friction made the protocols effectively frozen in their initial asset set.

### 3.2 Not Composable by Other Programs

On-chain options were typically represented as bespoke positions tracked inside the options protocol's own account structures. Another DeFi protocol — a structured-product vault, a lending market, an AI agent — could not natively hold or reason about an option position because the option was not a token. It was an entry in a private ledger. The consequence was that on-chain options remained a destination product rather than a primitive. Other protocols could not build on top of them without tight bilateral integrations. The rest of DeFi could not use them as building blocks.

### 3.3 Not Self-Aware

Options have an intrinsic time dimension — expiry. Strike price, underlying asset, expiry, and option type collectively define the instrument. In prior protocols, this information was usually stored off-chain in the protocol's frontend metadata or in a separate registry. After expiry, the option position required an explicit settlement instruction from the protocol operator to resolve. The option itself did not "know" it had expired. It could not be programmatically queried for its terms by another contract without indirection. It was inert data, not an instrument.

Each of these failures individually is tractable. But composability particularly is a chain-level feature — it depends on what the underlying protocol's token standard supports. For years, the Ethereum and Solana token standards in use did not support the metadata, transfer-hook, and delegated-burn primitives that a self-aware, composable option token would require. Protocols had to either build bespoke wrappers or accept the limitation.

That constraint was lifted when Solana's Token-2022 standard reached production readiness with its extensions framework. Opta's core insight is that the three specific extensions needed to make an option token self-enforcing, composable, and self-describing all exist in Token-2022 today — and can be combined in a single mint to produce an instrument category that has not previously existed on any chain.

---

## 4. The Living Option Token

The Living Option Token is Opta's defining primitive. It is a standard SPL Token-2022 mint with three extensions configured at creation time such that the token, as a runtime object, encodes and enforces the properties of the financial instrument it represents. We describe each extension, its role, and what the combination makes possible.

### 4.1 TransferHook — Time-Aware Transfers

The TransferHook extension allows a Token-2022 mint to designate a separate on-chain program that will be invoked on every transfer of the token. The hook program can perform arbitrary checks — including time-based checks — and veto the transfer by returning an error. Opta deploys a dedicated transfer-hook program with its own program ID and configures every option mint to point to it. The hook's logic is simple but consequential: before expiry, transfers are permitted freely and without protocol intervention; after expiry, user-to-user transfers are rejected. The protocol retains the right to move the token for settlement via a separate mechanism described below.

The implication is that expiry enforcement is not a protocol-level check that the frontend must remember to perform. It is a token-level invariant enforced by the token itself. Any program that tries to transfer an expired option token — whether the Opta frontend, a third-party aggregator, an AI agent, a structured-product vault, or a malicious actor attempting to unload an expired position on an unsuspecting counterparty — will find the transfer rejected by the Solana runtime itself. The token enforces its own expiry.

### 4.2 PermanentDelegate — Settlement Without Custody

The PermanentDelegate extension designates a program-derived address as a permanent delegate authority over every token in the mint. This means the delegate — which is an Opta protocol PDA, not a keypair controlled by any person — can burn tokens from any holder's account without that holder's explicit consent at the moment of the burn.

This is not a backdoor. It is the specific mechanism by which on-chain options settlement works without custody. At settlement, Opta computes which positions are in-the-money and which are not. For positions that expire worthless, the protocol burns the option tokens directly from the holder's wallet using the PermanentDelegate authority. For positions that expire in-the-money, the protocol pays the payoff in USDC from the writer's locked collateral and then burns the option token. At no point does the protocol take custody of user funds. The option token's economic life is automatically resolved at expiry, and the token itself is destroyed as part of that resolution.

Critically, the PermanentDelegate authority is a PDA, not a keypair. It is derived from protocol seeds and can be exercised only through calls to specific on-chain instructions that enforce settlement logic. No human holds the key. The capability is scoped to settlement mechanics, enforced by program code, and auditable by anyone reading the source.

### 4.3 MetadataPointer — Term Sheet On-Chain

The MetadataPointer extension attaches a metadata account to the token mint containing arbitrary structured data. Opta uses this to store the option's complete term sheet: the underlying asset identifier, the strike price, the expiry timestamp, the option type (call or put), and the associated market account. This information is not held in a frontend database or a separate protocol registry. It is on-chain metadata attached to the token mint itself.

The consequence is that any on-chain program — a lending protocol, a portfolio tracker, an AI agent acting on behalf of a user — can query an option's complete terms directly from the token mint, without needing to know anything about Opta's internal account layout. The token is self-describing. It is a primitive that other protocols can reason about without requiring custom integration.

### 4.4 The Combination Is the Innovation

Each of these three extensions exists individually. Token-2022 has been live in production since 2023 and each extension has seen isolated use in other projects — transfer hooks for compliance tokens, permanent delegates for confidential transfer demonstrations, metadata pointers for NFT-adjacent use cases. What has not been done, to our knowledge, is the combination of all three in a single mint to create a financial instrument that is simultaneously self-enforcing, self-settling, and self-describing.

The result is what we call the Living Option Token: an option represented as a token that carries its own expiry enforcement, its own settlement authority, and its own complete term sheet. It is a tradable, composable, self-aware instrument. It can be listed on any Solana DEX during its life. It can be held as collateral by any lending protocol that reads its metadata. It can be acquired by an AI agent that queries its terms directly. It can be placed inside a structured-product vault. And at expiry, it resolves itself, without requiring the protocol operator to maintain watch or intervene.

This is the primitive. Everything else in Opta's architecture — the liquidity model, the pricing engine, the frontend, the crank bot — exists to make the primitive usable and to turn it into a functioning market.

---

## 5. Architecture

Opta is implemented as two on-chain programs deployed on Solana devnet, with a full frontend application deployed on Vercel. The architecture is designed around the Living Option Token and scales outward from there.

### 5.1 On-Chain Programs

The main protocol program is deployed at program ID `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` on Solana devnet. It contains twenty-four instructions covering the full lifecycle of option creation, purchase, exercise, settlement, and shared-vault liquidity management. The instructions are grouped into two sets: thirteen instructions implementing the core peer-to-peer protocol (market creation, writing, purchasing, exercise, expiry, cancellation, the V1 resale marketplace, and the pricing configuration), and eleven instructions implementing the V2 shared-vault liquidity system described in section 7.

The transfer-hook program is deployed separately at program ID `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG`. Its sole responsibility is to enforce the expiry-based transfer veto described in section 4.1. It is small, auditable, and has a single instruction.

Both programs are written in Rust using the Anchor framework version 0.32.1. The code is formally structured with state accounts in a `state/` module, instructions in an `instructions/` module, error types in a central `errors.rs`, and the Black-Scholes math library imported from the `solmath` crate. The release build profile enables overflow checks and full link-time optimisation, reflecting a safety-oriented compilation stance.

### 5.2 State Accounts

Eight primary account types form the protocol's on-chain state. The `Protocol` account is the singleton root, holding global configuration. The `Market` account represents a specific option contract — underlying asset, strike, expiry, type — and is the parent account for all positions written against it. The `Position` account tracks a buyer's holdings of a specific option (though in practice the option token itself is the primary representation of the position, and the Position account is used for lifecycle bookkeeping). The `WriterPosition` account tracks the collateral locked by an option writer and the premium they have accrued. The `Pricing` account holds per-market volatility and risk-free-rate parameters used by the Black-Scholes engine. The `EpochConfig` account defines the settlement windows for V2 shared vaults. The `SharedVault` account is the V2 liquidity pool backing a set of related markets. The `VaultMint` account tracks vault-issued option tokens.

The separation between Market, Position, and WriterPosition accounts reflects a careful design decision. Markets are shared — any number of writers and buyers can transact against a single market. Positions are individual to buyers. Writer positions are individual to writers. This separation makes the shared-vault liquidity model possible without custom account rewriting, because writers' collateral obligations are scoped to their WriterPosition accounts regardless of which specific option tokens buyers end up holding.

### 5.3 Frontend Application

The frontend is a React nineteen application built with Vite eight and TypeScript five-point-nine, deployed on Vercel. It provides six pages: a landing page, a markets page showing all live option markets with their pricing grids, a Deribit-style trading page for purchasing options, a writing page for minting new options against collateral, a portfolio page showing the user's positions with automatic in-the-money and out-of-the-money classification, and a docs page.

Client-side, the application uses the Solana wallet adapter for connection, `@coral-xyz/anchor` for program interaction, and a custom polyfills module to handle Buffer polyfilling under Vite eight. Live spot prices are fetched from CoinGecko and Jupiter with static fallbacks for robustness. The Black-Scholes fair-value computation is performed both on-chain (for composability) and client-side (for grid rendering performance) — the frontend computation uses the same mathematical formulation as the on-chain engine and is validated against it.

### 5.4 Data Flow: A Purchase in Full

To make the architecture concrete, we trace a complete option purchase from user intent to on-chain resolution.

The user lands on the Trade page. The frontend fetches all live markets and filters them to V2 vault-backed markets using the `vaultFilters` module. It calls `usePythPrices` to obtain live spot prices for each underlying asset and computes Black-Scholes fair values for the full grid of strikes and expiries. The user selects a specific option — a call on SOL at strike price one hundred dollars expiring in twenty-four hours, for example. The frontend displays the model's fair value, the market's asked premium, and the implied Greeks.

The user clicks Buy. The frontend constructs a `purchase_from_vault` instruction referencing the market account, the shared vault that backs it, the user's wallet, and the USDC token account from which premium will be paid. The transaction is signed and submitted. On-chain, the program verifies the vault has sufficient capacity, transfers the option tokens from the vault's escrow associated token account to the buyer's ATA, invokes the transfer hook (which confirms expiry has not yet passed), transfers the premium in USDC from the buyer to the vault, and updates the vault's internal accounting.

The buyer now holds option tokens in their wallet. The tokens are freely transferable to any other address before expiry — the transfer hook permits it. The tokens are visible in any wallet or portfolio tracker that reads Token-2022 metadata — the metadata pointer makes the term sheet discoverable. The tokens can be listed on any Solana DEX that supports Token-2022 — though the V2 vault-specific secondary market infrastructure is still in development, as discussed in section 9.

At expiry, the admin — or in the mainnet design, a permissionless Pyth oracle reader — calls `settle_market`, which records the underlying's spot price at expiry on-chain. For positions that are in-the-money, the holder calls `exercise_from_vault` to receive the payoff in USDC, and the option token is burned via the PermanentDelegate authority. For positions that are out-of-the-money, the holder's token expires worthless and is burned by the crank bot's `expire_option` sweep. For writers whose options expired worthless, they call `withdraw_post_settlement` to recover their collateral plus accrued premium.

### 5.5 The Crank Bot

A separate TypeScript process, the crank bot, runs on a sixty-second timer and performs automation tasks that would otherwise require manual intervention: settling markets at expiry, exercising in-the-money positions on behalf of inactive holders, and expiring out-of-the-money tokens. In the current devnet deployment, the crank bot reads from a hardcoded price map — a deliberate hackathon simplification. The mainnet design replaces this with live Pyth oracle reads.

---

## 6. Pricing

Pricing options on-chain has been a persistent challenge for on-chain derivatives protocols. The Black-Scholes formula and its extensions require logarithmic, exponential, and cumulative normal distribution computations that are expensive in general-purpose VM environments. Prior protocols have typically adopted one of three compromises: rely on off-chain oracles pushing prices computed by centralised servers, approximate the pricing surface with lookup tables, or support only simplified pricing models that lose accuracy in high-volatility regimes.

Opta takes a different approach. It implements Black-Scholes pricing natively on Solana, computed on-chain in approximately fifty thousand compute units per quote, using a custom mathematics library called `solmath`.

### 6.1 Solmath and the Cost of On-Chain Math

The `solmath` library provides fixed-point implementations of the transcendental functions required for options pricing: natural logarithm, exponential, square root, and the cumulative standard normal distribution. These are implemented using series approximations calibrated for the precision-versus-compute trade-off specific to Solana's SBF runtime. The library's implementation choices are driven by the goal of keeping a full Black-Scholes call or put price computation under fifty thousand compute units — well within Solana's per-instruction compute budget even when combined with the surrounding instruction logic.

The fifty-thousand figure is notable in context. Solana's default per-transaction compute budget is two hundred thousand compute units, extendable to one point four million with a compute-budget instruction. A fifty-thousand-compute-unit pricing call leaves substantial headroom for the rest of the instruction's work — account deserialisation, validation, state updates, and CPI calls to the token program and transfer hook.

### 6.2 Asset-Class-Aware Volatility

Options pricing is more than the formula. It requires per-asset volatility inputs and a risk-free-rate input. Opta maintains a `Pricing` account per market that stores the volatility parameter calibrated to the asset class — crypto assets carry different implied volatilities than tokenised gold, which in turn differs from tokenised treasuries. In the current devnet deployment these values are seeded at market creation and can be updated through the `update_pricing` instruction. The mainnet design contemplates oracle-sourced implied volatility surfaces for the most active assets, but for the current stage this is explicitly a manually-configured parameter.

### 6.3 Greeks

In addition to fair value, the Opta pricing engine computes the five standard option Greeks: delta, gamma, vega, theta, and rho. These are exposed through the `initialize_pricing` and `update_pricing` instructions and are displayed in the frontend grid. For the current devnet deployment, the Greeks are computed client-side for rendering performance, using the same mathematical formulation that the on-chain engine uses for fair value. The Greeks are verified by CPI composability: any other on-chain program can call into the pricing module and receive consistent Greek values.

### 6.4 Why This Matters

The significance of on-chain Black-Scholes is not computational novelty. It is trust minimisation and composability. A price that is computed on-chain can be verified on-chain. Any downstream program that consumes Opta's pricing — a structured-product vault building a covered-call strategy, a lending protocol accepting option tokens as collateral, an AI agent constructing a hedge — does not need to trust an off-chain server. The price is a function of on-chain state, computable by anyone, auditable by anyone, and consistent across all callers.

---

## 7. The Three-Layer Liquidity Model

Options markets present a hard liquidity problem. Every option is unique in four dimensions — underlying, strike, expiry, type — which fragments liquidity in a way that simple spot markets do not experience. An options venue must solve this fragmentation or accept that most markets will be thin, wide-spread, and unusable for institutional size.

Opta's answer is a three-layer liquidity architecture. The layers are not alternatives to one another; they compose. Each layer serves a distinct set of use cases, and together they form a coherent liquidity surface across the full option chain.

### 7.1 Layer One — Isolated Escrows (V1 Peer-to-Peer)

The first layer is the classic peer-to-peer model: a writer locks collateral in an isolated escrow account scoped to a single market and a single position; a buyer pays premium in exchange for the option tokens; the collateral remains locked until settlement or cancellation.

This layer is appropriate for bespoke, illiquid, or large-notional positions where neither counterparty wants to commingle with a shared pool. It is also the layer that currently supports on-chain secondary trading: the V1 resale marketplace allows a position holder to list their option for sale to a third buyer, with the listing state tracked on-chain and the escrow transferred atomically on purchase. This resale infrastructure is fully live on devnet.

### 7.2 Layer Two — Shared Vaults (V2)

The second layer is the shared-vault model, introduced in the V2 protocol upgrade and now the default for all new markets via the `USE_V2_VAULTS = true` feature flag. A shared vault is a collateral pool open to any writer who wants to participate. Multiple writers deposit USDC into the vault, the vault mints option tokens against that pooled collateral, and buyers purchase those tokens paying premium into the vault. When options expire, the settlement economics are resolved at the vault level: losses are drawn from the pool, gains are distributed pro-rata to depositors based on their share.

Shared vaults offer three advantages. Capital efficiency — writers do not need to match buyers individually but can provide liquidity in advance and earn premium as buyers arrive. Scale — vault sizes can grow to levels that individual writers would not or could not reach. Specialisation — a vault can be thematic (a BTC call vault, a tokenised-gold put vault, a BUIDL short-delta vault) and attract depositors with specific risk-return preferences.

### 7.3 Layer Three — The Routing Layer

The third layer is the router. When a buyer submits a purchase intent, the router determines how best to fill it given the state of V1 and V2 liquidity. For markets where both layers are active, it selects the layer with better economics for the buyer. For markets where only one layer has capacity, it routes there. The router is implemented as a TypeScript SDK wrapping the on-chain programs, and the frontend's `purchase_from_vault` and related flows go through it.

### 7.4 Why Three Layers Is the Right Number

The three-layer design reflects a deliberate separation of concerns. Isolated escrows handle the long tail of bespoke positions. Shared vaults handle the bulk of standardised exposure with capital efficiency. The router makes the complexity invisible to users. Other protocols have tried to force all liquidity into a single model — all peer-to-peer, or all AMM, or all vault — and have invariably discovered that options markets have genuinely different liquidity needs across different use cases. Opta's three-layer model is an explicit bet that matching layer to use case yields strictly better outcomes than forcing a single model.

---

## 8. Security

A derivatives protocol is only as useful as it is safe. Opta's security posture is built on four overlapping practices: a comprehensive automated test suite, multi-round formal audits, safety-oriented compilation and language choices, and a deliberate posture of honest public documentation of known limitations.

### 8.1 The Test Suite

Opta has ninety-five tests across six test suites, running under Mocha and `ts-mocha` and invoked by `anchor test`. The test count is not an aesthetic achievement — it reflects the protocol's breadth. The primary suite, `butter-options.ts`, covers thirty-six tests of core protocol lifecycle: market creation, writing, purchasing, exercise, expiry, cancellation, resale, and pricing. The `shared-vaults.ts` suite adds twenty-three tests of the V2 vault lifecycle. The `pricing.ts` suite adds nineteen tests of the Black-Scholes engine, including asset-class variations and edge cases. The `zzz-audit-fixes.ts` suite, deliberately named to run last in the Mocha alphabetical ordering, contains twelve tests verifying specific audit findings remain fixed. The `poc-C1-expire-before-settle.ts` suite contains three tests for a specific critical vulnerability that was discovered, exploited as a proof-of-concept, fixed, and verified. The `token2022-smoke.ts` suite contains two tests exercising the Token-2022 extension interactions end-to-end.

The suite currently passes at ninety-five of ninety-five, with zero failures and zero pending tests, as verified on commit `ff08458`. The wall-clock time for a full test run is approximately three minutes for the Mocha execution and five minutes including the Anchor rebuild.

### 8.2 Five Rust Audit Rounds

The on-chain Rust programs have been subjected to five distinct audit rounds. Each round produced findings at a range of severities — critical, high, medium, and low — and each round's findings were fixed, tested, and committed before the next round began. Cumulatively, eighteen findings were raised and eighteen findings were resolved. Zero open findings remain. The audit history is documented in the project's `CLAUDE.md` file with commit hashes, finding IDs, and the specific tests added to verify each fix.

Notably, the audit process discovered a critical vulnerability — a race condition in the expiry-before-settle sequence — that was developed into a full working proof-of-concept exploit, patched, and then preserved in the test suite as a regression check. The exploit PoC remains in the repository as `poc-C1-expire-before-settle.ts` so that any future refactor that accidentally reintroduces the vulnerability will fail the test suite immediately.

### 8.3 Two Frontend Audits

The frontend application has been subjected to two rounds of audit separately from the on-chain programs. The audit reports are committed to the repository as `FRONTEND_AUDIT_REPORT.md` and `FRONTEND_AUDIT_REPORT_2.md`. The frontend audit surface covers wallet handling, transaction construction, amount parsing, error surface, devnet-safety warnings, and the Buffer polyfill pattern required for Vite eight compatibility.

### 8.4 Safety-Oriented Build Profile

The release build profile for the on-chain programs enables overflow checks (`overflow-checks = true`) and full link-time optimisation (`lto = "fat"`). Overflow checks catch integer overflow bugs in production rather than silently wrapping, which for a financial protocol is non-negotiable — a silent overflow in a collateral calculation could mint free options. The build profile is explicit in the `Cargo.toml` workspace configuration.

### 8.5 Honest Documentation

Every known limitation, every hackathon shortcut, and every piece of unfinished work is documented inline in the source code with explicit markers. The `settle_market.rs` file contains a multi-line `HACKATHON NOTE` comment at line five explaining that admin-supplied settlement pricing is a deliberate scope reduction for the hackathon and pointing to the exact line at which Pyth integration would replace it. The `pricing-crank.ts` file contains a `TODO: Replace with live Pyth price fetching before mainnet` annotation. The constants files contain layered `DEVNET ONLY — NOT FOR MAINNET` warnings on any value that is a devnet shortcut.

The philosophy is that a reader who opens the code and discovers a limitation should find that limitation documented rather than hidden. This matters for audit purposes, for future contributors, and for sophisticated readers of this whitepaper who will look for the things that an aspirational description omits.

---

## 9. Current State and Honest Limitations

Any protocol at the Opta stage — a hackathon submission pursuing mainnet ambition — has meaningful gaps between what is shipped and what is required for production. This section enumerates those gaps directly.

### 9.1 What Is Live

The protocol is deployed on Solana devnet at the program IDs listed in section 5.1. Both programs compile, deploy, and execute successfully. All ninety-five tests pass. The frontend is live on Vercel with the full user flow exercised: wallet connect, market browse, option purchase, position management, exercise, and settlement. The Living Option Token behaves as designed — transfer-hook expiry enforcement works, PermanentDelegate settlement burn works, MetadataPointer term sheet is readable. Five Rust audits and two frontend audits have closed. The crank bot runs.

### 9.2 Living Option Tokens Cannot Yet Trade on Secondary (V2 Vault Markets)

The most material gap, and the one we want to surface clearly, is secondary trading of Living Option Tokens issued by V2 shared vaults. To be precise about the state: V1 peer-to-peer options, which are written against isolated escrows, have full on-chain resale infrastructure today — listing, cancellation, purchase, escrow transfer, all live on devnet and tested. V2 shared-vault option tokens, which are now the default for new markets, do not yet have equivalent on-chain listing and matching infrastructure.

The token mechanics support secondary trading: the transfer hook permits pre-expiry transfers, the PermanentDelegate does not interfere with user-to-user transfers, and the metadata is queryable by any program. What is missing is the protocol-side on-chain listing state: a `VaultResaleListing` account type, an escrow PDA for seller holdings during a listing, and three new instructions (`list_vault_resale`, `buy_vault_resale`, `cancel_vault_resale`). The V1 resale infrastructure is structurally bound to the `OptionPosition` account type and cannot be adapted directly to V2 vault-issued tokens; a parallel set of accounts and instructions is required.

This work is on the Phase 2 roadmap. It requires three new Rust instructions, one new account type, one new escrow PDA, a new test suite, and a program redeploy. It is not tonight's work. We surface it here because a whitepaper that claimed "fully composable, freely tradable" of V2 vault tokens would be overclaiming the current state, and we would rather name the gap than have readers discover it.

### 9.3 Admin-Only Settlement

The `settle_market` instruction currently accepts a settlement price as an admin-supplied parameter rather than reading it from a Pyth oracle feed. This is a deliberate hackathon scope reduction, documented inline in the source at `settle_market.rs`. The rationale is that making settlement permissionless via on-chain oracle reads is a specific engineering task with its own testing surface, and the team prioritised completing end-to-end lifecycle coverage before adding oracle composability. The Pyth integration point is documented in the source at line fifty-five of `settle_market.rs`. This is a required change before any mainnet deployment.

### 9.4 Hardcoded Devnet Price Map in Crank

The crank bot currently uses a hardcoded price map for the handful of devnet assets (SOL at one hundred ninety-five, BTC at one hundred five thousand, ETH at three thousand six hundred, XAU at three thousand one hundred). This is a devnet-only convenience that eliminates the need for the crank bot to make live Pyth network calls during hackathon demos. For mainnet, the crank bot must be rewritten to fetch live Pyth prices before settlement. This is documented with a `TODO` comment in the crank source.

### 9.5 Upgrade Authority and Program Governance

Both on-chain programs are currently under the upgrade authority of a single keypair — the deployer's — which means in principle the programs could be upgraded at any time. For a devnet hackathon deployment this is appropriate; for mainnet it is not. The mainnet design calls for the upgrade authority to be migrated to a multisig, and eventually to be revoked entirely. This migration is a straightforward Anchor operation but must be done deliberately and as part of a broader governance-hardening milestone.

### 9.6 European-Style Settlement, USDC-Only Collateral

Opta currently supports only European-style options (exercisable only at expiry) and only USDC-denominated collateral and premium. This is a simplification that was chosen for audit tractability — American-style options introduce early-exercise logic that widens the attack surface, and multi-collateral support introduces oracle and pricing complexity that compounds with every asset added. These simplifications are appropriate for the current stage. American-style options and multi-collateral support are plausible Phase 3 items but are not currently scoped.

### 9.7 The Legacy V1 Vault Code

The V2 shared-vault system is the active default via the `USE_V2_VAULTS = true` feature flag. The V1 peer-to-peer code remains in the repository and is exercised by the V1 resale infrastructure described in section 7.1. We have deliberately preserved V1 because it supports a use case (bespoke large-notional P2P options with isolated escrow) that V2 shared vaults do not fully replicate. A decision about whether to fully retire V1 or to continue maintaining both in parallel is deferred to a later milestone.

### 9.8 The Rename Is Phased

As mentioned in the introduction, the project was renamed from Butter Options to Opta on 2026-04-21. Phase 1 of the rename — documentation, GitHub repository, frontend display strings, Vercel project, socials — was completed on that date. Phase 2 — Rust program names, directory paths (`programs/butter-options/`), PDA seed string constants, `declare_id!()` macros, and IDL regeneration — is parked until after Colosseum judging to avoid any risk of breaking the live demo deployment. A reader of the source code will therefore see `butter_options` as the Rust program name while the brand is Opta. This is not a bug; it is a deliberate phased operation, documented in the repository's HANDOFF.md with a rename-notice blockquote at the top of the file.

---

## 10. Progressive Decentralisation Roadmap

The philosophy for Opta's path to production is progressive decentralisation — a term borrowed from Jesse Walden's 2020 essay that has since become standard in serious DeFi projects. The core idea is that full decentralisation at day one is a mistake — it prevents the protocol operator from fixing bugs, iterating on economics, or responding to emergent issues — but remaining centralised indefinitely is also a mistake, because the whole point of on-chain protocols is censorship resistance and credible neutrality. The right path is to begin with operator-controlled simplicity, harden progressively, and end at permissionless.

Opta's decentralisation milestones are concrete.

### 10.1 Phase 1 — Current State (Devnet, Admin-Controlled)

Where Opta is today. Admin controls settlement pricing. Admin controls upgrade authority. A single crank bot runs settlement automation. This is appropriate for a hackathon submission and for initial mainnet preparation. It is explicitly not the destination.

### 10.2 Phase 2 — Pyth-Permissionless Settlement

Replace admin-supplied settlement prices with Pyth oracle reads inside `settle_market`. After this change, anyone can call `settle_market` at or after expiry, and the correct price is enforced by the on-chain oracle read. Settlement becomes permissionless. This is the single most important decentralisation milestone for the protocol and is the critical blocker for any mainnet launch with real funds. It also requires updating the crank bot to fetch live Pyth prices rather than reading from its hardcoded devnet map.

### 10.3 Phase 3 — Multisig Upgrade Authority

Migrate the program upgrade authority from the deployer keypair to a multisig. Solana's Squads protocol or an equivalent multisig framework is the likely destination. This reduces the counterparty risk of the upgrade authority to the multisig signer set and makes emergency fixes require explicit multi-party approval.

### 10.4 Phase 4 — Permissionless Crank

The crank bot's responsibilities — settlement triggering, in-the-money exercise, out-of-the-money expiry — should be performable by anyone, not just by the admin's crank. This means adding small economic incentives (a small fee paid to the caller of each crank instruction, funded from protocol fees) and removing any admin-only gating on the crank instructions. After this change, the crank bot the team runs is one of many possible crank runners, and the protocol is robust to the admin's crank going offline.

### 10.5 Phase 5 — Revoke Upgrade Authority

Burn the upgrade authority entirely. The programs become immutable. This is the terminal state of progressive decentralisation. It should not happen until the protocol has been in production for long enough that any remaining bugs are unlikely to require emergency fixes — typically at least a year of mainnet operation with meaningful volume. The revocation is irreversible and is a one-way commitment to the current program code.

### 10.6 Beyond Decentralisation: The Governance Question

Orthogonal to the decentralisation path is the question of whether Opta should introduce a governance token and a DAO. The honest answer at this stage is: maybe, but not yet. A governance token introduced prematurely becomes a distraction from building the core protocol, attracts mercenary capital without corresponding contribution, and commits the team to regulatory and operational complexity that is inappropriate for an early-stage project. If Opta reaches meaningful mainnet volume and faces genuine parameter-choice decisions (listing new markets, adjusting fees, upgrading risk parameters), a governance layer becomes appropriate. Until then, it is a deferred decision.

---

## 11. The Fourth Primitive Claim

A stronger framing we want to offer, carefully, is that Opta represents a claim on being the fourth foundational primitive of DeFi.

The three established primitives are decentralised exchanges (spot trading), lending markets (collateralised borrowing), and stablecoins (tokenised monetary units). Each emerged at a specific time, was initially served by protocols that were later supplanted by more composable successors, and became a permanent feature of the DeFi stack. DEXes evolved from EtherDelta to Uniswap to 1inch. Lending evolved from MakerDAO and Compound to Aave and Morpho. Stablecoins evolved from early experiments to USDC, DAI, and sDAI. At each stage, the category matured by becoming more composable and more integrated with the rest of the stack.

Options have been conspicuously absent from this list. Every DeFi cycle has produced some number of on-chain options protocols, and none has achieved the category-defining status of Uniswap or Aave. We believe this is not because options are the wrong primitive — tradfi dominance by options is compelling evidence otherwise — but because the previous attempts ran into specific structural blockers that have now been resolved.

Opyn introduced tokenised options on Ethereum in 2020 but used the pre-extensions ERC-20 standard, so the tokens could not enforce their own expiry or carry settlement authority. Lyra built sophisticated AMM-based options on Optimism but required complex market-maker tooling that never fully attracted institutional liquidity. Dopex built structured products on Arbitrum but tied its identity to the veDPX tokenomics layer rather than to being an open primitive. PsyOptions, the most serious early Solana options effort, used the pre-Token-2022 SPL standard which had none of the extension machinery that makes self-enforcing tokens possible. The original Zeta options product predated Token-2022 entirely and was built around bespoke position accounts. Thetanuts served the long-tail asset niche but relied on off-chain vault operators. Each of these is a serious protocol. None has become the options equivalent of Uniswap.

The claim Opta makes is not that it is categorically better than these protocols in every respect. The claim is that Opta is the first options protocol to be built on a token standard that supports the full set of extensions required for a truly self-enforcing, composable, self-describing option token — and that the combination of that primitive with Solana's RWA-heavy ecosystem composition produces the specific setup in which the fourth DeFi primitive can finally take hold.

Whether this claim proves correct will be decided by adoption, not by whitepapers. We surface it here because understanding the ambition is relevant to evaluating the design choices. Opta is not built to be a slightly better options protocol. It is built to be the options primitive — in the same sense that Uniswap is the DEX primitive.

---

## 12. Comparison With Prior Art

Direct protocol-by-protocol comparison, focused on the specific dimensions that distinguish Opta's design.

| Protocol | Chain | Token Standard | Self-Enforcing Expiry | On-Chain Term Sheet | On-Chain Pricing | Composability |
|---|---|---|---|---|---|---|
| Opyn | Ethereum | ERC-20 | No — protocol-level | No — off-chain | Off-chain | Position-level |
| Lyra | Optimism | Custom AMM | No — pool-level | Partial | Off-chain | Pool-level |
| Dopex | Arbitrum | ERC-20 wrapped | No — protocol-level | No | Off-chain | Limited |
| PsyOptions | Solana | SPL (legacy) | No — protocol-level | No — registry | Off-chain | Position-level |
| Zeta (original options) | Solana | Custom accounts | No — settlement-level | Partial | Off-chain | Bespoke |
| Thetanuts | Multi | Vault shares | No — vault-level | No | Off-chain | Vault-level |
| Opta | Solana | Token-2022 | Yes — transfer-hook | Yes — metadata pointer | On-chain Black-Scholes | Token-level |

The critical row is the first: Opta is the only protocol whose option instrument enforces its own expiry at the token level, via a standard Solana runtime mechanism. This is not a feature addition. It is a primitive change.

A few honest notes on this table. Protocols evolve. Lyra has iterated through multiple versions. Zeta has pivoted. Thetanuts has expanded. The descriptions above reflect each protocol's defining design period, not necessarily its current state. Opta is itself early, and some of the rows about Opta describe the current devnet state rather than a mainnet-deployed reality. The table is meant to be descriptive of the architectural approach, not a scoring of who is "better" today.

---

## 13. Conclusion

Opta is an attempt to build the options primitive that on-chain DeFi has needed for five years and that Solana specifically has needed for one. The design is not speculative — every element is implemented, tested, and audited in the current devnet deployment. The thesis is empirical — each of the four pillars that motivates the protocol is grounded in publicly verifiable data on institutional derivatives flow, on Solana's ecosystem composition, and on traditional finance's options-dominant reference class. The roadmap is explicit — progressive decentralisation from the current admin-controlled devnet state toward a fully permissionless mainnet primitive.

The ambition is to be the fourth DeFi primitive. The execution is early. The path between here and there passes through Phase 2 of the rename, through Pyth-permissionless settlement, through the V2 vault secondary trading work, through multisig governance migration, and through whatever else adversarial contact with mainnet reveals. We do not claim that path is short. We claim that it is built on a primitive — the Living Option Token — that has not previously existed and that is specifically fit to the market it is designed for.

We welcome review, critique, and collaboration from Superteam, the Solana Foundation, and the broader Solana developer community. This whitepaper is version one. It will evolve as the protocol does.

---

## Appendix A — Instruction Set

The main Opta program exposes twenty-four instructions, grouped into the core peer-to-peer protocol (thirteen) and the shared-vault liquidity system (eleven).

**Core P2P protocol (V1):** `initialize_protocol`, `create_market`, `write_option`, `purchase_option`, `settle_market`, `exercise_option`, `expire_option`, `cancel_option`, `list_for_resale`, `buy_resale`, `cancel_resale`, `initialize_pricing`, `update_pricing`.

**Shared vault system (V2):** `initialize_epoch_config`, `create_shared_vault`, `deposit_to_vault`, `mint_from_vault`, `purchase_from_vault`, `burn_unsold_from_vault`, `withdraw_from_vault`, `claim_premium`, `settle_vault`, `exercise_from_vault`, `withdraw_post_settlement`.

The transfer-hook program exposes a single instruction implementing the Token-2022 transfer-hook interface.

---

## Appendix B — Account Structures

Eight primary account types.

`Protocol` — singleton root account; global configuration. `Market` — an option market definition (underlying, strike, expiry, type). `Position` — a buyer's lifecycle bookkeeping for a specific purchase. `WriterPosition` — a writer's collateral and premium accounting for a specific market. `Pricing` — per-market volatility and risk-free-rate parameters for the Black-Scholes engine. `EpochConfig` — settlement windows for V2 shared vaults. `SharedVault` — the V2 liquidity pool backing a set of related markets. `VaultMint` — a vault-issued option mint and its associated state.

All state accounts are defined in `programs/butter-options/src/state/`. The directory name reflects the Phase 2 code-rename still outstanding; the logical content is the Opta protocol state layout described above.

---

## Appendix C — References

Futures Industry Association. 2023 Global Derivatives Volume Report.

Hyperliquid Hub and PANews. Wallet concentration analysis of Hyperliquid cumulative volume, Q1 2026.

Solana Foundation. March 2026 Ecosystem Report: RWA Activity Acceleration on Solana.

Walden, Jesse. Progressive Decentralization: A Playbook for Building Crypto Applications. Variant Fund, 2020.

Solana Program Library. Token-2022 Extensions Documentation, Solana Labs.

Pyth Network. Pull Oracle Model and Price Feed Documentation.

Black, F. and Scholes, M. The Pricing of Options and Corporate Liabilities. Journal of Political Economy, 1973.

Opta. Source repository at `github.com/nankolib/opta`. Seed context in `HANDOFF.md`. Audit history in `CLAUDE.md`. Test suite invoked by `anchor test`.

---

*This whitepaper was prepared for submission to Superteam Pakistan and, through them, to the Solana Foundation. Questions, critiques, and collaboration requests are welcome. The authoritative source of truth for the protocol's current state is the public repository; this document reflects the state as of 2026-04-21.*
