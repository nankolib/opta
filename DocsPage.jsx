import { useState } from "react";

const SECTIONS = [
  {
    id: "overview",
    title: "Overview",
    icon: "◉",
    content: [
      {
        heading: "What is Butter Options?",
        body: `Butter Options is a permissionless, peer-to-peer options protocol built on Solana. It allows anyone to create, trade, and settle options on any asset that has a Pyth oracle price feed — including cryptocurrencies, commodities, equities, forex pairs, and tokenized funds like Ondo's OUSG.

The protocol introduces the Living Option Token — the first self-expiring financial instrument token on Solana. Built using Token-2022 extensions, each option token carries its full financial terms in on-chain metadata, enforces its own expiry through a transfer hook, and can be burned by the protocol through a permanent delegate.

The token doesn't just represent an option — it behaves like one.`
      },
      {
        heading: "Key Numbers",
        type: "stats",
        stats: [
          { label: "Instructions", value: "11" },
          { label: "Tests Passing", value: "27/27" },
          { label: "Asset Classes", value: "5" },
          { label: "Protocol Fee", value: "0.5%" },
        ]
      },
      {
        heading: "Three Design Principles",
        type: "cards",
        cards: [
          {
            title: "Isolated Escrow",
            subtitle: "Not shared vaults",
            body: "Every option has its own escrow PDA. No pool, no shared vault, nothing to drain. After Drift lost ~$270M from a shared vault, we chose safety over capital efficiency."
          },
          {
            title: "Tokenized Positions",
            subtitle: "Real SPL tokens",
            body: "Every option mints a unique SPL token. Whoever holds it can exercise. Composable with all of Solana DeFi — DAOs, DEXes, lending protocols, structured products."
          },
          {
            title: "Living Option Token",
            subtitle: "The token IS the option",
            body: "Token-2022 with transfer hook (blocks after expiry), permanent delegate (protocol can burn), and metadata (full financial terms on-chain). Novel — doesn't exist anywhere else."
          },
        ]
      }
    ]
  },
  {
    id: "living-token",
    title: "Living Option Token",
    icon: "◈",
    content: [
      {
        heading: "What Makes It \"Living\"?",
        body: `Every token in crypto today is static. A USDC is a USDC forever. An NFT sits in your wallet unchanged. Even option tokens on existing protocols are just dumb receipts — they represent an option, but they don't actually behave like an option.

A real option in TradFi loses value every second. The moment you buy it, a clock starts ticking. Theta eats away at its value. When it expires, it's literally worth zero.

The Living Option Token understands this. It knows its expiry date, carries its financial terms, and literally refuses to be transferred after it expires.`
      },
      {
        heading: "The Three Extensions",
        type: "extensions",
        extensions: [
          {
            name: "Transfer Hook",
            what: "A program that runs on every transfer. Checks the expiry timestamp. Blocks the transfer if expired.",
            why: "The token dies when it expires. No wallet, DEX, or smart contract can trade a dead option.",
            color: "#EF4444"
          },
          {
            name: "Permanent Delegate",
            what: "Gives the protocol permanent authority to burn any option token without the holder's signature.",
            why: "Enables automatic cleanup of expired tokens, settlement mechanics, and exercise burns.",
            color: "#F59E0B"
          },
          {
            name: "Metadata Extension",
            what: "Stores full financial terms on the mint: asset, strike, expiry, type, Pyth oracle, collateral per token.",
            why: "Any wallet or protocol can read it and know what the token represents. Phantom shows \"BUTTER-SOL-200C-APR15\" instead of \"Unknown.\"",
            color: "#10B981"
          },
        ]
      },
      {
        heading: "What the Token Looks Like On-Chain",
        type: "code",
        code: `name:     BUTTER-SOL-200C-APR15
symbol:   bOPT
─────────────────────────────────
asset:               SOL
class:               crypto
type:                call
strike:              $200
expiry:              1744675200 (Apr 15)
pyth:                H6ARH...f4Cey
collateral_per_token: $20 USDC
market:              [market PDA]
─────────────────────────────────
transfer_hook:       blocks after expiry
permanent_delegate:  protocol can burn
metadata:            all terms readable`
      }
    ]
  },
  {
    id: "instructions",
    title: "The 11 Instructions",
    icon: "⬡",
    content: [
      {
        heading: "Protocol Setup",
        type: "instruction-table",
        instructions: [
          { num: 1, name: "initialize_protocol", desc: "One-time setup. Creates protocol state, sets admin, treasury, and fee rate (0.5%).", who: "Admin" },
          { num: 2, name: "create_market", desc: "Creates a new options market for any asset with a Pyth oracle. Specify asset name, strike, expiry, type, and asset class.", who: "Anyone" },
        ]
      },
      {
        heading: "Primary Trading",
        type: "instruction-table",
        instructions: [
          { num: 3, name: "write_option", desc: "Seller locks USDC collateral in isolated escrow. Protocol mints Living Option Tokens (Token-2022 with all 3 extensions) into purchase escrow.", who: "Anyone" },
          { num: 4, name: "purchase_option", desc: "Buyer pays premium in USDC, receives option tokens. 99.5% to writer, 0.5% to treasury. Supports partial fills.", who: "Anyone (not writer)" },
          { num: 5, name: "cancel_option", desc: "Writer burns all unsold tokens and reclaims collateral. Only works before any sale.", who: "Writer only" },
        ]
      },
      {
        heading: "Settlement & Exercise",
        type: "instruction-table",
        instructions: [
          { num: 6, name: "settle_market", desc: "Sets final settlement price after expiry from Pyth oracle. Determines ITM vs OTM.", who: "Admin" },
          { num: 7, name: "exercise_option", desc: "Token holder burns tokens and receives proportional payout from escrow.", who: "Token holder" },
          { num: 8, name: "expire_option", desc: "Returns remaining collateral to writer for unexercised options.", who: "Anyone" },
        ]
      },
      {
        heading: "Secondary Market (P2P)",
        type: "instruction-table",
        instructions: [
          { num: 9, name: "list_for_resale", desc: "Token holder lists on built-in P2P marketplace. Tokens go to resale escrow. Seller sets price.", who: "Token holder" },
          { num: 10, name: "buy_resale", desc: "Buy from a resale listing. Supports partial fills. 0.5% protocol fee.", who: "Anyone (not lister)" },
          { num: 11, name: "cancel_resale", desc: "Remove listing and get tokens back from escrow.", who: "Lister only" },
        ]
      },
    ]
  },
  {
    id: "accounts",
    title: "Accounts & PDAs",
    icon: "⬢",
    content: [
      {
        heading: "How Data is Stored",
        body: "Solana programs store all data in \"accounts\" on the blockchain. Each account has an address and holds data. Butter uses Program Derived Addresses (PDAs) — addresses computed deterministically from \"seeds\" so anyone can find them without a lookup."
      },
      {
        heading: "Account Map",
        type: "account-table",
        accounts: [
          { name: "ProtocolState", seeds: '["protocol_state"]', stores: "Admin, treasury, fee rate, market count" },
          { name: "OptionsMarket", seeds: '["options_market", index_bytes]', stores: "Asset, strike, expiry, settlement price, type, class, Pyth address" },
          { name: "OptionPosition", seeds: '["option_position", market, writer]', stores: "Writer, premium, supply, tokens sold, collateral, escrow, mint" },
          { name: "Collateral Escrow", seeds: '["escrow", market, writer]', stores: "USDC token account — writer's locked collateral" },
          { name: "Purchase Escrow", seeds: '["purchase_escrow", position]', stores: "Token-2022 account — unsold option tokens" },
          { name: "ResaleListing", seeds: '["resale_listing", position, seller]', stores: "Seller, price per token, quantity" },
          { name: "Resale Escrow", seeds: '["resale_escrow", listing]', stores: "Token-2022 account — tokens listed for resale" },
          { name: "ExtraAccountMetaList", seeds: '["extra-account-metas", mint] (hook)', stores: "Extra accounts for transfer hook validation" },
          { name: "HookState", seeds: '["hook-state", mint] (hook)', stores: "Expiry timestamp for transfer hook" },
        ]
      },
    ]
  },
  {
    id: "assets",
    title: "Any-Asset Support",
    icon: "◇",
    content: [
      {
        heading: "Permissionless Markets",
        body: `Butter Options does not have a hardcoded list of supported assets. Any asset with a Pyth Network oracle price feed can have an options market created for it.

When someone calls create_market, they provide the asset name as a string and the Pyth oracle address. The protocol doesn't validate whether the asset is "approved" — it simply creates the market. This is permissionless by design.`
      },
      {
        heading: "Asset Class Profiles",
        type: "asset-classes",
        classes: [
          { name: "Crypto", code: 0, vol: "High (60–120%+)", time: "24/7 continuous", risk: "Jump risk premium", examples: "SOL, BTC, ETH, BONK", color: "#8B5CF6" },
          { name: "Commodity", code: 1, vol: "Low–Med (15–30%)", time: "Trading hours", risk: "Supply shock premium", examples: "Gold, Oil, Silver", color: "#F59E0B" },
          { name: "Equity", code: 2, vol: "Medium (20–40%)", time: "252 days/yr", risk: "Earnings event spike", examples: "AAPL, TSLA, MSTR", color: "#3B82F6" },
          { name: "Forex", code: 3, vol: "Low (5–15%)", time: "24/5 weekdays", risk: "Central bank events", examples: "EUR/USD, GBP/USD", color: "#10B981" },
          { name: "ETF / Fund", code: 4, vol: "Low (5–20%)", time: "Varies", risk: "Depeg risk premium", examples: "OUSG, BUIDL, SPY", color: "#EC4899" },
        ]
      },
      {
        heading: "Black-Scholes Improvements",
        type: "cards",
        cards: [
          { title: "Realized Volatility", subtitle: "From Pyth oracle data", body: "Calculates actual vol from price data, not a static number. Calm market = cheap options. Chaotic market = expensive options." },
          { title: "Jump Risk Premium", subtitle: "For flash crashes", body: "Counts large moves (10%+) and adds a surcharge. SOL (jumpy) costs more than gold (smooth)." },
          { title: "Surge Pricing", subtitle: "Vault utilization", body: "Premiums rise as vault fills up, like ride-share surge pricing. Self-regulating. (Phase 3)" },
          { title: "24/7 Time Decay", subtitle: "Continuous model", body: "Uses 8,760 hours/year for crypto instead of 252 trading days. A 6-hour crypto option isn't worthless." },
        ]
      }
    ]
  },
  {
    id: "security",
    title: "Security",
    icon: "◆",
    content: [
      {
        heading: "Isolated Escrow Model",
        body: `The most important security decision in Butter Options. Every option position has its own dedicated escrow PDA. When a writer locks $2,000 USDC as collateral, that $2,000 sits in a separate account that cannot be accessed by any other position, user, or instruction.

There is no pool. There is no shared vault. There is nothing for an attacker to drain because there is no central place where funds accumulate.`
      },
      {
        heading: "Security Measures",
        type: "cards",
        cards: [
          { title: "Self-Buy Prevention", subtitle: "", body: "Writers can't buy their own options. Listers can't buy their own resale. Prevents wash trading." },
          { title: "Protocol-Signed Escrow", subtitle: "", body: "All escrow transfers signed by protocol PDA, not individual users. No single wallet controls funds." },
          { title: "Atomic Transactions", subtitle: "", body: "Every instruction fully succeeds or fully reverts. No partial state where collateral is locked but tokens aren't minted." },
          { title: "European Settlement", subtitle: "", body: "Exercise only after settlement. Eliminates early exercise complexity and attack surface." },
        ]
      },
      {
        heading: "Phase 3 Vault Protection (5 Layers)",
        type: "vault-layers",
        layers: [
          { num: 1, name: "Exposure Caps", desc: "Max 30% of vault deployed at any time. 70% always in reserve." },
          { num: 2, name: "Concentration Limits", desc: "No single asset exceeds a set % of total vault exposure." },
          { num: 3, name: "Directional Hedging", desc: "Calls offset puts on same asset. Net exposure matters, not gross." },
          { num: 4, name: "Insurance Fund", desc: "Portion of premium profits set aside as first-line buffer." },
          { num: 5, name: "Circuit Breakers", desc: "Auto-pause on drawdown threshold breach. Prevents cascading losses." },
        ]
      }
    ]
  },
  {
    id: "lifecycle",
    title: "Option Lifecycle",
    icon: "↻",
    content: [
      {
        heading: "From Creation to Settlement",
        type: "lifecycle",
        steps: [
          { num: 1, title: "Create Market", desc: "Specify asset, strike, expiry, type (call/put), and asset class. Protocol creates an OptionsMarket account.", color: "#8B5CF6" },
          { num: 2, title: "Write Option", desc: "Seller locks USDC collateral. Protocol mints Living Option Tokens with metadata, transfer hook, and permanent delegate.", color: "#3B82F6" },
          { num: 3, title: "Purchase Option", desc: "Buyer pays premium in USDC, receives tokens from escrow. Partial fills supported.", color: "#10B981" },
          { num: 4, title: "Secondary Trading", desc: "Token holders list on P2P marketplace at any price. Transfer hook allows pre-expiry transfers only.", color: "#F59E0B" },
          { num: 5, title: "Settlement", desc: "After expiry, settlement price set from Pyth oracle. Determines ITM vs OTM.", color: "#EF4444" },
          { num: 6, title: "Exercise / Expire", desc: "Call: max(0, settlement − strike). Put: max(0, strike − settlement). OTM = zero, collateral returned to writer.", color: "#EC4899" },
        ]
      }
    ]
  },
  {
    id: "cpi",
    title: "CPI & Composability",
    icon: "⟁",
    content: [
      {
        heading: "Cross-Program Invocation",
        body: `CPI means "your program calls our program." It's how protocols on Solana talk to each other. All 11 Butter Options instructions are callable via CPI — no permission needed.`
      },
      {
        heading: "Integration Examples",
        type: "cards",
        cards: [
          { title: "Perps Platforms", subtitle: "Jupiter, Drift", body: "One-click hedging for leveraged positions. Call purchase_option via CPI to buy puts automatically." },
          { title: "Lending Protocols", subtitle: "Collateral", body: "Accept option tokens as collateral — they're real SPL tokens with known, on-chain terms." },
          { title: "Structured Products", subtitle: "Yield vaults", body: "Write options automatically to generate premium yield. Call write_option from a vault program." },
          { title: "AI Agents", subtitle: "The token is the API", body: "Read token metadata, compute fair value from Pyth, execute trades — all via standard Solana RPC. No SDK needed." },
        ]
      },
    ]
  },
  {
    id: "fees",
    title: "Fees",
    icon: "◎",
    content: [
      {
        heading: "Fee Schedule",
        type: "fee-table",
        fees: [
          { tx: "purchase_option", fee: "0.5%", payer: "Buyer (from premium)", dest: "Treasury" },
          { tx: "buy_resale", fee: "0.5%", payer: "Buyer (from price)", dest: "Treasury" },
          { tx: "write_option", fee: "None", payer: "—", dest: "—" },
          { tx: "exercise_option", fee: "None", payer: "—", dest: "—" },
          { tx: "cancel_option", fee: "None", payer: "—", dest: "—" },
        ]
      },
      {
        heading: "",
        body: "Fee rate and treasury address are stored in ProtocolState and are configurable by the admin."
      }
    ]
  },
  {
    id: "tech",
    title: "Tech Stack & Tests",
    icon: "⚙",
    content: [
      {
        heading: "Technology",
        type: "tech-table",
        tech: [
          { component: "Blockchain", value: "Solana (devnet → mainnet)" },
          { component: "Smart Contract", value: "Anchor 0.32.1 (Rust)" },
          { component: "Token Standard", value: "SPL Token-2022" },
          { component: "Rust", value: "1.89.0" },
          { component: "Solana CLI", value: "2.3.0" },
          { component: "Oracle", value: "Pyth Network" },
          { component: "Collateral", value: "USDC (standard SPL Token)" },
          { component: "Frontend", value: "React + TypeScript + Tailwind" },
          { component: "Built With", value: "Claude Code" },
        ]
      },
      {
        heading: "Test Coverage — 27/27 Passing",
        type: "test-table",
        tests: [
          { group: "initialize_protocol", count: 2, verifies: "Setup + double-init prevention" },
          { group: "create_market", count: 2, verifies: "Creation + parameter validation" },
          { group: "write_option", count: 3, verifies: "Call, put, insufficient collateral" },
          { group: "purchase_option", count: 2, verifies: "Premium split + partial fills" },
          { group: "cancel_option", count: 2, verifies: "Pre-sale cancel + post-sale block" },
          { group: "Post-expiry suite", count: 5, verifies: "Settlement, exercise, expire" },
          { group: "Resale market", count: 2, verifies: "List + buy resale" },
          { group: "Partial fills", count: 3, verifies: "Multiple buyers, partial qty" },
          { group: "Token-2022 extensions", count: 4, verifies: "Hook, metadata, delegate" },
          { group: "Token-2022 smoke", count: 2, verifies: "Extension init sanity" },
        ]
      },
    ]
  },
  {
    id: "roadmap",
    title: "Roadmap",
    icon: "→",
    content: [
      {
        heading: "",
        type: "roadmap",
        phases: [
          { phase: "Phase 1", title: "Core Protocol", desc: "11 instructions, isolated escrow, tokenized positions, P2P resale, fees", status: "complete" },
          { phase: "Phase 1.5", title: "Living Option Token", desc: "Token-2022 with transfer hook, permanent delegate, metadata extensions", status: "complete" },
          { phase: "Phase 2", title: "Any-Asset + Pricing", desc: "Permissionless assets, asset-class profiles, Black-Scholes improvements, CPI docs", status: "complete" },
          { phase: "Phase 2.5", title: "Launch Prep", desc: "Devnet deployment, frontend, demo video, Colosseum hackathon submission", status: "progress" },
          { phase: "Phase 3", title: "Vaults", desc: "Protocol-managed vaults with 5-layer protection, automated market making", status: "designed" },
          { phase: "Phase 4", title: "Mainnet", desc: "Mainnet launch, security audit, institutional integrations", status: "planned" },
          { phase: "Phase 5", title: "Expansion", desc: "Cross-chain, governance token, advanced strategies, AI agent marketplace", status: "vision" },
        ]
      }
    ]
  },
];

// ── Renderers ──

function RenderStats({ stats }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, margin: "20px 0" }}>
      {stats.map((s, i) => (
        <div key={i} style={{ background: "var(--card-bg)", borderRadius: 10, padding: "20px 16px", textAlign: "center", border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--gold)", fontFamily: "var(--mono)" }}>{s.value}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, textTransform: "uppercase", letterSpacing: 1 }}>{s.label}</div>
        </div>
      ))}
    </div>
  );
}

function RenderCards({ cards }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: cards.length === 4 ? "1fr 1fr" : `repeat(${Math.min(cards.length, 3)}, 1fr)`, gap: 14, margin: "16px 0" }}>
      {cards.map((c, i) => (
        <div key={i} style={{ background: "var(--card-bg)", borderRadius: 10, padding: 20, border: "1px solid var(--border)", transition: "border-color 0.2s" }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{c.title}</div>
          {c.subtitle && <div style={{ fontSize: 12, color: "var(--gold)", marginTop: 2 }}>{c.subtitle}</div>}
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8, lineHeight: 1.6 }}>{c.body}</div>
        </div>
      ))}
    </div>
  );
}

function RenderExtensions({ extensions }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, margin: "16px 0" }}>
      {extensions.map((e, i) => (
        <div key={i} style={{ background: "var(--card-bg)", borderRadius: 10, padding: 20, borderLeft: `3px solid ${e.color}`, border: "1px solid var(--border)", borderLeftColor: e.color, borderLeftWidth: 3 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{e.name}</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6, lineHeight: 1.6 }}><strong style={{ color: "var(--text)" }}>What:</strong> {e.what}</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4, lineHeight: 1.6 }}><strong style={{ color: "var(--text)" }}>Why:</strong> {e.why}</div>
        </div>
      ))}
    </div>
  );
}

function RenderCode({ code }) {
  return (
    <pre style={{ background: "var(--code-bg)", borderRadius: 10, padding: 20, fontSize: 13, lineHeight: 1.7, color: "var(--gold)", fontFamily: "var(--mono)", overflowX: "auto", border: "1px solid var(--border)", margin: "16px 0" }}>
      {code}
    </pre>
  );
}

function RenderInstructionTable({ instructions }) {
  return (
    <div style={{ margin: "12px 0", borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "40px 170px 1fr 120px", background: "var(--header-bg)", padding: "10px 16px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)" }}>
        <span>#</span><span>Instruction</span><span>Description</span><span>Who</span>
      </div>
      {instructions.map((inst, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "40px 170px 1fr 120px", padding: "12px 16px", fontSize: 13, borderTop: "1px solid var(--border)", background: i % 2 === 0 ? "transparent" : "var(--card-bg)" }}>
          <span style={{ color: "var(--gold)", fontWeight: 600, fontFamily: "var(--mono)" }}>{inst.num}</span>
          <span style={{ color: "var(--text)", fontFamily: "var(--mono)", fontSize: 12, fontWeight: 500 }}>{inst.name}</span>
          <span style={{ color: "var(--muted)", lineHeight: 1.5 }}>{inst.desc}</span>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>{inst.who}</span>
        </div>
      ))}
    </div>
  );
}

function RenderAccountTable({ accounts }) {
  return (
    <div style={{ margin: "12px 0", borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "160px 260px 1fr", background: "var(--header-bg)", padding: "10px 16px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)" }}>
        <span>Account</span><span>Seeds</span><span>Stores</span>
      </div>
      {accounts.map((a, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "160px 260px 1fr", padding: "10px 16px", fontSize: 13, borderTop: "1px solid var(--border)", background: i % 2 === 0 ? "transparent" : "var(--card-bg)" }}>
          <span style={{ color: "var(--text)", fontWeight: 500, fontSize: 12 }}>{a.name}</span>
          <span style={{ color: "var(--gold)", fontFamily: "var(--mono)", fontSize: 11 }}>{a.seeds}</span>
          <span style={{ color: "var(--muted)", lineHeight: 1.5 }}>{a.stores}</span>
        </div>
      ))}
    </div>
  );
}

function RenderAssetClasses({ classes }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "16px 0" }}>
      {classes.map((c, i) => (
        <div key={i} style={{ background: "var(--card-bg)", borderRadius: 10, padding: 18, borderTop: `3px solid ${c.color}`, border: "1px solid var(--border)", borderTopColor: c.color, borderTopWidth: 3 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{c.name}</span>
            <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: c.color, background: `${c.color}18`, padding: "2px 8px", borderRadius: 4 }}>code: {c.code}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, lineHeight: 1.7 }}>
            <div><strong style={{ color: "var(--text)" }}>Volatility:</strong> {c.vol}</div>
            <div><strong style={{ color: "var(--text)" }}>Time model:</strong> {c.time}</div>
            <div><strong style={{ color: "var(--text)" }}>Risk factor:</strong> {c.risk}</div>
            <div style={{ marginTop: 4, color: "var(--gold)", fontSize: 11 }}>{c.examples}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RenderLifecycle({ steps }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, margin: "16px 0" }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 40 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: s.color, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 14, fontFamily: "var(--mono)", flexShrink: 0 }}>{s.num}</div>
            {i < steps.length - 1 && <div style={{ width: 2, height: 40, background: "var(--border)", margin: "4px 0" }} />}
          </div>
          <div style={{ paddingBottom: i < steps.length - 1 ? 16 : 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{s.title}</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4, lineHeight: 1.6 }}>{s.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RenderVaultLayers({ layers }) {
  return (
    <div style={{ margin: "16px 0" }}>
      {layers.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: i < layers.length - 1 ? "1px solid var(--border)" : "none" }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: `var(--gold)`, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--bg)", fontWeight: 700, fontSize: 13, fontFamily: "var(--mono)", flexShrink: 0 }}>{l.num}</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{l.name}</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{l.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RenderRoadmap({ phases }) {
  const statusColors = { complete: "#10B981", progress: "#3B82F6", designed: "#8B5CF6", planned: "#F59E0B", vision: "#6B7280" };
  const statusLabels = { complete: "Complete", progress: "In Progress", designed: "Designed", planned: "Planned", vision: "Vision" };
  return (
    <div style={{ margin: "16px 0" }}>
      {phases.map((p, i) => (
        <div key={i} style={{ display: "flex", gap: 16, alignItems: "flex-start", padding: "16px 0", borderBottom: i < phases.length - 1 ? "1px solid var(--border)" : "none" }}>
          <div style={{ minWidth: 80, fontSize: 12, fontWeight: 600, color: "var(--gold)", fontFamily: "var(--mono)", paddingTop: 2 }}>{p.phase}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{p.title}</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 3, lineHeight: 1.5 }}>{p.desc}</div>
          </div>
          <span style={{ fontSize: 11, fontWeight: 600, color: statusColors[p.status], background: `${statusColors[p.status]}18`, padding: "3px 10px", borderRadius: 20, whiteSpace: "nowrap", flexShrink: 0 }}>
            {statusLabels[p.status]}
          </span>
        </div>
      ))}
    </div>
  );
}

function RenderSimpleTable({ items, columns }) {
  return (
    <div style={{ margin: "12px 0", borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
      <div style={{ display: "grid", gridTemplateColumns: columns.map(c => c.width || "1fr").join(" "), background: "var(--header-bg)", padding: "10px 16px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)" }}>
        {columns.map((c, i) => <span key={i}>{c.label}</span>)}
      </div>
      {items.map((item, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: columns.map(c => c.width || "1fr").join(" "), padding: "10px 16px", fontSize: 13, borderTop: "1px solid var(--border)", background: i % 2 === 0 ? "transparent" : "var(--card-bg)" }}>
          {columns.map((c, j) => <span key={j} style={{ color: j === 0 ? "var(--text)" : "var(--muted)", fontFamily: j === 0 ? "var(--mono)" : "inherit", fontSize: j === 0 ? 12 : 13, fontWeight: j === 0 ? 500 : 400 }}>{item[c.key]}</span>)}
        </div>
      ))}
    </div>
  );
}

function ContentRenderer({ block }) {
  if (block.type === "stats") return <RenderStats stats={block.stats} />;
  if (block.type === "cards") return <><SectionHeading text={block.heading} /><RenderCards cards={block.cards} /></>;
  if (block.type === "extensions") return <><SectionHeading text={block.heading} /><RenderExtensions extensions={block.extensions} /></>;
  if (block.type === "code") return <><SectionHeading text={block.heading} /><RenderCode code={block.code} /></>;
  if (block.type === "instruction-table") return <><SectionHeading text={block.heading} /><RenderInstructionTable instructions={block.instructions} /></>;
  if (block.type === "account-table") return <><SectionHeading text={block.heading} /><RenderAccountTable accounts={block.accounts} /></>;
  if (block.type === "asset-classes") return <><SectionHeading text={block.heading} /><RenderAssetClasses classes={block.classes} /></>;
  if (block.type === "lifecycle") return <><SectionHeading text={block.heading} /><RenderLifecycle steps={block.steps} /></>;
  if (block.type === "vault-layers") return <><SectionHeading text={block.heading} /><RenderVaultLayers layers={block.layers} /></>;
  if (block.type === "roadmap") return <RenderRoadmap phases={block.phases} />;
  if (block.type === "fee-table") return <><SectionHeading text={block.heading} /><RenderSimpleTable items={block.fees} columns={[{ key: "tx", label: "Transaction", width: "180px" }, { key: "fee", label: "Fee", width: "80px" }, { key: "payer", label: "Who Pays" }, { key: "dest", label: "Destination", width: "100px" }]} /></>;
  if (block.type === "tech-table") return <><SectionHeading text={block.heading} /><RenderSimpleTable items={block.tech} columns={[{ key: "component", label: "Component", width: "160px" }, { key: "value", label: "Technology" }]} /></>;
  if (block.type === "test-table") return <><SectionHeading text={block.heading} /><RenderSimpleTable items={block.tests} columns={[{ key: "group", label: "Group", width: "180px" }, { key: "count", label: "#", width: "50px" }, { key: "verifies", label: "Verifies" }]} /></>;
  
  return (
    <>
      {block.heading && <SectionHeading text={block.heading} />}
      {block.body && <div style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.8, whiteSpace: "pre-line" }}>{block.body}</div>}
    </>
  );
}

function SectionHeading({ text }) {
  if (!text) return null;
  return <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: "24px 0 8px", padding: 0 }}>{text}</h3>;
}

export default function DocsPage() {
  const [active, setActive] = useState("overview");
  const section = SECTIONS.find(s => s.id === active);

  return (
    <div style={{
      "--bg": "#0C0C14",
      "--card-bg": "rgba(255,255,255,0.03)",
      "--border": "rgba(255,255,255,0.08)",
      "--text": "#E8E4DA",
      "--muted": "rgba(232,228,218,0.55)",
      "--gold": "#C9A84C",
      "--header-bg": "rgba(201,168,76,0.08)",
      "--code-bg": "rgba(201,168,76,0.06)",
      "--mono": "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      fontFamily: "'Instrument Sans', 'DM Sans', -apple-system, sans-serif",
      background: "var(--bg)",
      color: "var(--text)",
      minHeight: "100vh",
      display: "flex",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* Sidebar */}
      <nav style={{
        width: 240,
        minHeight: "100vh",
        borderRight: "1px solid var(--border)",
        padding: "28px 0",
        position: "sticky",
        top: 0,
        flexShrink: 0,
        overflowY: "auto",
      }}>
        <div style={{ padding: "0 20px 24px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--gold)", letterSpacing: -0.5 }}>BUTTER</div>
          <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 2, marginTop: 2 }}>Protocol Docs</div>
        </div>

        <div style={{ padding: "16px 0" }}>
          {SECTIONS.map(s => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 20px",
                border: "none",
                background: active === s.id ? "rgba(201,168,76,0.1)" : "transparent",
                color: active === s.id ? "var(--gold)" : "var(--muted)",
                fontSize: 13,
                fontWeight: active === s.id ? 600 : 400,
                cursor: "pointer",
                textAlign: "left",
                borderLeft: active === s.id ? "2px solid var(--gold)" : "2px solid transparent",
                transition: "all 0.15s",
                fontFamily: "inherit",
              }}
            >
              <span style={{ fontSize: 14, opacity: 0.7, width: 18 }}>{s.icon}</span>
              {s.title}
            </button>
          ))}
        </div>

        <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)", marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
            Program ID<br />
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)", wordBreak: "break-all" }}>CtzJ4MJYX6...z9Cq</span>
          </div>
        </div>
      </nav>

      {/* Main */}
      <main style={{ flex: 1, maxWidth: 860, padding: "36px 48px 80px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: 24, opacity: 0.4 }}>{section.icon}</span>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: -0.5 }}>{section.title}</h1>
        </div>
        <div style={{ width: 48, height: 2, background: "var(--gold)", borderRadius: 1, marginBottom: 32 }} />

        {section.content.map((block, i) => (
          <div key={i} style={{ marginBottom: 16 }}>
            <ContentRenderer block={block} />
          </div>
        ))}
      </main>
    </div>
  );
}
