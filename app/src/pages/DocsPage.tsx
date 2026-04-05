import { FC, useState, useEffect, useRef } from "react";

/* ============================================================================
   Butter Options — Protocol Documentation Page

   Self-contained docs page with sidebar navigation and 11 sections.
   All content is hardcoded. No API calls.
   ============================================================================ */

// ---------------------------------------------------------------------------
// Color tokens (CSS variable overrides for this page)
// ---------------------------------------------------------------------------
const C = {
  bg: "#0C0C14",
  bgCard: "#12121C",
  bgCardHover: "#181826",
  bgSidebar: "#0A0A12",
  border: "#1E1E2E",
  borderLight: "#2A2A3A",
  gold: "#C9A84C",
  goldDim: "#A8893A",
  goldGlow: "rgba(201,168,76,0.12)",
  cream: "#E8E4DA",
  muted: "#8A8A9A",
  mutedDim: "#5A5A6A",
  red: "#EF4444",
  amber: "#F59E0B",
  green: "#22C55E",
  blue: "#3B82F6",
  purple: "#9945FF",
  pink: "#EC4899",
  solGreen: "#14F195",
} as const;

// ---------------------------------------------------------------------------
// Section definitions
// ---------------------------------------------------------------------------
interface Section {
  id: string;
  label: string;
  icon: string;
}

const SECTIONS: Section[] = [
  { id: "overview", label: "Overview", icon: "◈" },
  { id: "living-token", label: "Living Option Token", icon: "◉" },
  { id: "instructions", label: "The 11 Instructions", icon: "⚙" },
  { id: "accounts", label: "Accounts & PDAs", icon: "⬡" },
  { id: "any-asset", label: "Any-Asset Support", icon: "◎" },
  { id: "security", label: "Security", icon: "⛨" },
  { id: "lifecycle", label: "Option Lifecycle", icon: "↻" },
  { id: "cpi", label: "CPI & Composability", icon: "⧉" },
  { id: "fees", label: "Fees", icon: "%" },
  { id: "tech-tests", label: "Tech Stack & Tests", icon: "⚡" },
  { id: "roadmap", label: "Roadmap", icon: "▸" },
];

// ---------------------------------------------------------------------------
// Reusable tiny components
// ---------------------------------------------------------------------------
const SectionTitle: FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2
    style={{
      fontSize: "1.75rem",
      fontWeight: 700,
      color: C.cream,
      marginBottom: "0.5rem",
      fontFamily: "'Instrument Sans', 'Inter', system-ui, sans-serif",
    }}
  >
    {children}
  </h2>
);

const SectionSubtitle: FC<{ children: React.ReactNode }> = ({ children }) => (
  <p style={{ color: C.muted, fontSize: "0.95rem", marginBottom: "1.5rem", lineHeight: 1.6 }}>
    {children}
  </p>
);

const Card: FC<{
  children: React.ReactNode;
  borderColor?: string;
  style?: React.CSSProperties;
}> = ({ children, borderColor, style }) => (
  <div
    style={{
      background: C.bgCard,
      border: `1px solid ${C.border}`,
      borderLeft: borderColor ? `3px solid ${borderColor}` : undefined,
      borderRadius: "0.75rem",
      padding: "1.25rem",
      ...style,
    }}
  >
    {children}
  </div>
);

const Badge: FC<{ color: string; children: React.ReactNode }> = ({ color, children }) => (
  <span
    style={{
      display: "inline-block",
      padding: "0.15rem 0.6rem",
      borderRadius: "9999px",
      fontSize: "0.7rem",
      fontWeight: 600,
      background: `${color}20`,
      color,
      border: `1px solid ${color}40`,
    }}
  >
    {children}
  </span>
);

const Mono: FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = C.gold,
}) => (
  <code
    style={{
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: "0.85em",
      color,
      background: `${color}10`,
      padding: "0.1rem 0.35rem",
      borderRadius: "0.25rem",
    }}
  >
    {children}
  </code>
);

// Table helper
const Table: FC<{ headers: string[]; rows: (string | React.ReactNode)[][] }> = ({
  headers,
  rows,
}) => (
  <div style={{ overflowX: "auto", marginBottom: "1.5rem" }}>
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "0.85rem",
        fontFamily: "'Instrument Sans', 'Inter', system-ui, sans-serif",
      }}
    >
      <thead>
        <tr>
          {headers.map((h, i) => (
            <th
              key={i}
              style={{
                textAlign: "left",
                padding: "0.75rem 1rem",
                borderBottom: `1px solid ${C.border}`,
                color: C.gold,
                fontWeight: 600,
                background: `${C.gold}08`,
                whiteSpace: "nowrap",
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} style={{ background: ri % 2 === 1 ? `${C.bgCard}` : "transparent" }}>
            {row.map((cell, ci) => (
              <td
                key={ci}
                style={{
                  padding: "0.65rem 1rem",
                  borderBottom: `1px solid ${C.border}`,
                  color: C.cream,
                  lineHeight: 1.5,
                }}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ---------------------------------------------------------------------------
// Section content components
// ---------------------------------------------------------------------------

const OverviewSection: FC = () => (
  <div>
    <SectionTitle>Butter Options Protocol</SectionTitle>
    <SectionSubtitle>
      Permissionless options infrastructure for every asset class on Solana. Create, trade, and
      settle options on any asset with a Pyth oracle feed — crypto, commodities, equities, forex,
      and tokenized funds.
    </SectionSubtitle>

    {/* Key stats */}
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: "1rem",
        marginBottom: "2rem",
      }}
    >
      {[
        { value: "11", label: "Instructions" },
        { value: "27/27", label: "Tests Passing" },
        { value: "5", label: "Asset Classes" },
        { value: "0.5%", label: "Protocol Fee" },
      ].map((s) => (
        <div
          key={s.label}
          style={{
            background: C.bgCard,
            border: `1px solid ${C.border}`,
            borderRadius: "0.75rem",
            padding: "1.25rem",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: "1.75rem",
              fontWeight: 700,
              color: C.gold,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {s.value}
          </div>
          <div style={{ fontSize: "0.8rem", color: C.muted, marginTop: "0.25rem" }}>
            {s.label}
          </div>
        </div>
      ))}
    </div>

    {/* Three principles */}
    <h3 style={{ color: C.cream, fontSize: "1.1rem", fontWeight: 600, marginBottom: "1rem" }}>
      Design Principles
    </h3>
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: "1rem",
      }}
    >
      {[
        {
          title: "Isolated Escrow",
          desc: "Every position has its own PDA escrow. No shared vault. No pool to drain. An attacker cannot steal funds that aren't aggregated.",
          color: C.green,
        },
        {
          title: "Tokenized Positions",
          desc: "Every option mints a unique SPL token. Hold it, trade it on a DEX, use it as collateral, or integrate it into structured products.",
          color: C.blue,
        },
        {
          title: "Living Option Token",
          desc: "Token-2022 with transfer hook (blocks after expiry), permanent delegate (protocol burn), and full metadata (terms on-chain).",
          color: C.gold,
        },
      ].map((p) => (
        <Card key={p.title} borderColor={p.color}>
          <div style={{ fontWeight: 600, color: p.color, marginBottom: "0.5rem" }}>{p.title}</div>
          <div style={{ color: C.muted, fontSize: "0.85rem", lineHeight: 1.6 }}>{p.desc}</div>
        </Card>
      ))}
    </div>
  </div>
);

const LivingTokenSection: FC = () => (
  <div>
    <SectionTitle>The Living Option Token</SectionTitle>
    <SectionSubtitle>
      Every token in crypto is static — it sits in your wallet unchanged forever. But real options
      decay. They expire. They carry terms. The Living Option Token is the first token on Solana that
      understands all of this. It doesn't just represent an option — it behaves like one.
    </SectionSubtitle>

    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "2rem" }}>
      <Card borderColor={C.red}>
        <div style={{ fontWeight: 600, color: C.red, marginBottom: "0.5rem", fontSize: "0.95rem" }}>
          Transfer Hook
        </div>
        <div style={{ color: C.muted, fontSize: "0.85rem", lineHeight: 1.6 }}>
          Runs automatically on every transfer. Checks the option's expiry timestamp — if expired,
          the transfer is blocked. The token literally dies when it expires. No wallet, DEX, or smart
          contract can override this.
        </div>
      </Card>
      <Card borderColor={C.amber}>
        <div style={{ fontWeight: 600, color: C.amber, marginBottom: "0.5rem", fontSize: "0.95rem" }}>
          Permanent Delegate
        </div>
        <div style={{ color: C.muted, fontSize: "0.85rem", lineHeight: 1.6 }}>
          Gives the protocol permanent authority to burn any option token without the holder's
          signature. Enables settlement mechanics (burn on exercise) and automatic cleanup of expired
          instruments.
        </div>
      </Card>
      <Card borderColor={C.green}>
        <div style={{ fontWeight: 600, color: C.green, marginBottom: "0.5rem", fontSize: "0.95rem" }}>
          Metadata Extension
        </div>
        <div style={{ color: C.muted, fontSize: "0.85rem", lineHeight: 1.6 }}>
          Stores the full financial terms directly on the token mint. Any wallet, protocol, or AI
          agent can read the metadata and know exactly what the token represents. Phantom shows the
          option name instead of "Unknown Token."
        </div>
      </Card>
    </div>

    {/* On-chain representation */}
    <h3 style={{ color: C.cream, fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem" }}>
      On-Chain Token Structure
    </h3>
    <pre
      style={{
        background: C.bgCard,
        border: `1px solid ${C.border}`,
        borderRadius: "0.75rem",
        padding: "1.25rem",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "0.8rem",
        color: C.gold,
        overflowX: "auto",
        lineHeight: 1.7,
      }}
    >
{`name:     BUTTER-SOL-200C-APR15
symbol:   bOPT
asset: SOL | class: crypto | type: call
strike: $200 | expiry: 1744675200 (Apr 15)
pyth: H6ARH...f4Cey
collateral_per_token: $20 USDC
transfer_hook: blocks after expiry
permanent_delegate: protocol can burn`}
    </pre>
  </div>
);

const InstructionsSection: FC = () => {
  const groups = [
    {
      title: "Protocol Setup",
      rows: [
        ["1", <Mono>initialize_protocol</Mono>, "One-time setup: creates protocol state, sets admin, treasury, and fee rate (0.5%)", "Admin only"],
        ["2", <Mono>create_market</Mono>, "Creates a new options market for any asset with a Pyth oracle feed", "Anyone"],
      ],
    },
    {
      title: "Primary Trading",
      rows: [
        ["3", <Mono>write_option</Mono>, "Seller locks USDC collateral in isolated escrow, mints Living Option Tokens into purchase escrow", "Anyone"],
        ["4", <Mono>purchase_option</Mono>, "Buyer pays premium in USDC, receives option tokens. 99.5% to writer, 0.5% to treasury. Partial fills", "Anyone (except writer)"],
        ["5", <Mono>cancel_option</Mono>, "Writer burns all unsold tokens and reclaims collateral. Only works before any sale", "Writer only"],
      ],
    },
    {
      title: "Settlement & Exercise",
      rows: [
        ["6", <Mono>settle_market</Mono>, "Sets final settlement price after expiry (from Pyth in production)", "Admin"],
        ["7", <Mono>exercise_option</Mono>, "Token holder burns tokens and receives proportional payout from escrow", "Token holder"],
        ["8", <Mono>expire_option</Mono>, "Returns remaining collateral to writer for unexercised options", "Anyone"],
      ],
    },
    {
      title: "Secondary Market (P2P Resale)",
      rows: [
        ["9", <Mono>list_for_resale</Mono>, "Token holder lists tokens on built-in P2P marketplace. Tokens go to resale escrow", "Token holder"],
        ["10", <Mono>buy_resale</Mono>, "Buyer purchases from resale listing. Supports partial fills. 0.5% fee", "Anyone (except lister)"],
        ["11", <Mono>cancel_resale</Mono>, "Lister removes listing and gets tokens back", "Lister only"],
      ],
    },
  ];

  return (
    <div>
      <SectionTitle>The 11 Instructions</SectionTitle>
      <SectionSubtitle>
        Every action in the protocol is one of these 11 on-chain instructions. All are callable via
        CPI by other Solana programs.
      </SectionSubtitle>
      {groups.map((g) => (
        <div key={g.title} style={{ marginBottom: "2rem" }}>
          <h3 style={{ color: C.gold, fontSize: "0.95rem", fontWeight: 600, marginBottom: "0.75rem" }}>
            {g.title}
          </h3>
          <Table headers={["#", "Instruction", "What It Does", "Who Can Call"]} rows={g.rows} />
        </div>
      ))}
    </div>
  );
};

const AccountsSection: FC = () => (
  <div>
    <SectionTitle>Accounts & PDAs</SectionTitle>
    <SectionSubtitle>
      Solana stores all data in accounts. Program Derived Addresses (PDAs) are deterministic
      addresses computed from "seeds" — anyone can derive them without on-chain lookups.
    </SectionSubtitle>
    <Table
      headers={["Account", "Seeds", "What It Stores"]}
      rows={[
        ["ProtocolState", <Mono>["protocol_state"]</Mono>, "Admin, treasury, fee rate, market count"],
        ["OptionsMarket", <Mono>["options_market", index]</Mono>, "Asset, strike, expiry, settlement price, type, class, Pyth address"],
        ["OptionPosition", <Mono>["option_position", market, writer]</Mono>, "Writer, premium, supply, tokens sold, collateral, escrow, mint"],
        ["Collateral Escrow", <Mono>["escrow", market, writer]</Mono>, "USDC holding the writer's locked collateral"],
        ["Purchase Escrow", <Mono>["purchase_escrow", position]</Mono>, "Token-2022 account holding unsold option tokens"],
        ["ResaleListing", <Mono>["resale_listing", position, seller]</Mono>, "Seller, price per token, quantity listed"],
        ["Resale Escrow", <Mono>["resale_escrow", listing]</Mono>, "Token-2022 account holding tokens listed for resale"],
        ["ExtraAccountMetaList", <Mono>["extra-account-metas", mint]</Mono>, "Extra accounts the transfer hook needs (hook program)"],
        ["HookState", <Mono>["hook-state", mint]</Mono>, "Expiry timestamp for transfer hook validation (hook program)"],
      ]}
    />
  </div>
);

const AnyAssetSection: FC = () => (
  <div>
    <SectionTitle>Any-Asset Support</SectionTitle>
    <SectionSubtitle>
      Butter Options is fully permissionless — any asset with a Pyth Network oracle price feed can
      have an options market created for it. No hardcoded list. No approval process.
    </SectionSubtitle>

    {/* Asset class cards */}
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: "1rem",
        marginBottom: "2rem",
      }}
    >
      {[
        { name: "Crypto", code: 0, color: C.purple, vol: "High (60–120%+)", time: "24/7 continuous", risk: "Jump risk premium", examples: "SOL, BTC, ETH, BONK, JUP" },
        { name: "Commodity", code: 1, color: C.amber, vol: "Low–Medium (15–30%)", time: "Trading hours + gaps", risk: "Supply shock premium", examples: "Gold (XAU), Silver, Oil (WTI)" },
        { name: "Equity", code: 2, color: C.blue, vol: "Medium (20–40%)", time: "252 trading days/yr", risk: "Earnings event spike", examples: "AAPL, TSLA, NVDA, MSTR" },
        { name: "Forex", code: 3, color: C.green, vol: "Low (5–15%)", time: "24/5 weekdays", risk: "Central bank events", examples: "EUR/USD, GBP/USD, JPY/USD" },
        { name: "ETF / Fund", code: 4, color: C.pink, vol: "Low (5–20%)", time: "Varies", risk: "Depeg risk premium", examples: "Ondo OUSG, BUIDL, USTB" },
      ].map((a) => (
        <Card key={a.name} borderColor={a.color}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <span style={{ fontWeight: 600, color: a.color, fontSize: "1rem" }}>{a.name}</span>
            <Badge color={a.color}>Code {a.code}</Badge>
          </div>
          <div style={{ fontSize: "0.8rem", color: C.muted, lineHeight: 1.7 }}>
            <div><strong style={{ color: C.cream }}>Volatility:</strong> {a.vol}</div>
            <div><strong style={{ color: C.cream }}>Time Model:</strong> {a.time}</div>
            <div><strong style={{ color: C.cream }}>Risk Factor:</strong> {a.risk}</div>
            <div style={{ marginTop: "0.5rem", color: C.mutedDim }}>{a.examples}</div>
          </div>
        </Card>
      ))}
    </div>

    {/* Black-Scholes improvements */}
    <h3 style={{ color: C.cream, fontSize: "1.1rem", fontWeight: 600, marginBottom: "1rem" }}>
      Four Black-Scholes Improvements
    </h3>
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: "1rem",
      }}
    >
      {[
        { title: "Realized Volatility", desc: "Calculates actual vol from Pyth oracle data instead of using a static number" },
        { title: "Jump Risk Premium", desc: "Counts large moves (10%+) and adds a surcharge for jumpy assets" },
        { title: "Surge Pricing", desc: "Premiums increase as vault utilization fills up (Phase 3)" },
        { title: "24/7 Time Decay", desc: "Uses 8,760 hours/year for crypto instead of 252 trading days" },
      ].map((b) => (
        <Card key={b.title}>
          <div style={{ fontWeight: 600, color: C.gold, fontSize: "0.9rem", marginBottom: "0.4rem" }}>
            {b.title}
          </div>
          <div style={{ color: C.muted, fontSize: "0.8rem", lineHeight: 1.6 }}>{b.desc}</div>
        </Card>
      ))}
    </div>
  </div>
);

const SecuritySection: FC = () => (
  <div>
    <SectionTitle>Security Architecture</SectionTitle>
    <SectionSubtitle>
      The protocol's core security principle: there is no pool. Every position has its own isolated
      escrow PDA. An attacker cannot drain the protocol because there is no central place where funds
      accumulate.
    </SectionSubtitle>

    {/* Security measures */}
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: "1rem",
        marginBottom: "2rem",
      }}
    >
      {[
        { title: "Self-Buy Prevention", desc: "Writers cannot purchase their own options on both primary and resale markets", color: C.red },
        { title: "Protocol-Signed Escrow", desc: "All escrow transfers are signed by the protocol PDA, not individual users", color: C.blue },
        { title: "Atomic Transactions", desc: "Every instruction fully succeeds or fully reverts — no partial state changes", color: C.green },
        { title: "European Settlement", desc: "Exercise only after settlement, eliminating early exercise complexity and manipulation", color: C.purple },
      ].map((s) => (
        <Card key={s.title} borderColor={s.color}>
          <div style={{ fontWeight: 600, color: s.color, fontSize: "0.9rem", marginBottom: "0.4rem" }}>
            {s.title}
          </div>
          <div style={{ color: C.muted, fontSize: "0.8rem", lineHeight: 1.6 }}>{s.desc}</div>
        </Card>
      ))}
    </div>

    {/* Phase 3 vault protection */}
    <h3 style={{ color: C.cream, fontSize: "1.1rem", fontWeight: 600, marginBottom: "1rem" }}>
      Phase 3 Vault Protection (Designed)
    </h3>
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {[
        { n: 1, title: "Exposure Caps", desc: "Max 30% of vault deployed at any time" },
        { n: 2, title: "Concentration Limits", desc: "No single asset exceeds a set % of vault exposure" },
        { n: 3, title: "Directional Hedging", desc: "Calls offset puts on same asset" },
        { n: 4, title: "Insurance Fund", desc: "Portion of premium profits set aside as buffer" },
        { n: 5, title: "Circuit Breakers", desc: "Auto-pause on drawdown threshold breach" },
      ].map((l) => (
        <div
          key={l.n}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            background: C.bgCard,
            border: `1px solid ${C.border}`,
            borderRadius: "0.75rem",
            padding: "1rem 1.25rem",
          }}
        >
          <div
            style={{
              minWidth: "2rem",
              height: "2rem",
              borderRadius: "50%",
              background: C.goldGlow,
              border: `1px solid ${C.gold}40`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "0.8rem",
              fontWeight: 700,
              color: C.gold,
            }}
          >
            {l.n}
          </div>
          <div>
            <div style={{ fontWeight: 600, color: C.cream, fontSize: "0.9rem" }}>{l.title}</div>
            <div style={{ color: C.muted, fontSize: "0.8rem" }}>{l.desc}</div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const LifecycleSection: FC = () => {
  const steps = [
    { n: 1, title: "Create Market", desc: "Specify asset, strike, expiry, type, and asset class. Protocol creates an OptionsMarket account.", color: C.purple },
    { n: 2, title: "Write Option", desc: "Seller locks USDC collateral. Protocol mints Living Option Tokens with full metadata, transfer hook, and permanent delegate.", color: C.blue },
    { n: 3, title: "Purchase Option", desc: "Buyer pays premium in USDC, receives tokens. Partial fills supported — buy 10 out of 100 available.", color: C.green },
    { n: 4, title: "Secondary Trading", desc: "Token holders list on the built-in P2P marketplace at any price. Transfer hook allows pre-expiry transfers, blocks post-expiry.", color: C.amber },
    { n: 5, title: "Settlement", desc: "After expiry, settlement price is set from Pyth oracle. Determines ITM vs OTM for all positions.", color: C.red },
    { n: 6, title: "Exercise / Expire", desc: "Call payout: max(0, settlement − strike). Put payout: max(0, strike − settlement). OTM options: collateral returned to writer.", color: C.pink },
  ];

  return (
    <div>
      <SectionTitle>Option Lifecycle</SectionTitle>
      <SectionSubtitle>
        From market creation to final settlement — every option follows this six-step lifecycle.
      </SectionSubtitle>
      <div style={{ position: "relative", paddingLeft: "2.5rem" }}>
        {/* Vertical line */}
        <div
          style={{
            position: "absolute",
            left: "1rem",
            top: "1.25rem",
            bottom: "1.25rem",
            width: "2px",
            background: `linear-gradient(to bottom, ${C.purple}, ${C.blue}, ${C.green}, ${C.amber}, ${C.red}, ${C.pink})`,
          }}
        />
        {steps.map((s, i) => (
          <div
            key={s.n}
            style={{
              position: "relative",
              marginBottom: i < steps.length - 1 ? "1.5rem" : 0,
              paddingLeft: "1.5rem",
            }}
          >
            {/* Circle */}
            <div
              style={{
                position: "absolute",
                left: "-1.5rem",
                top: "0.25rem",
                width: "1.25rem",
                height: "1.25rem",
                borderRadius: "50%",
                background: s.color,
                border: `3px solid ${C.bg}`,
                boxShadow: `0 0 8px ${s.color}60`,
              }}
            />
            <div style={{ fontWeight: 600, color: s.color, fontSize: "0.95rem", marginBottom: "0.25rem" }}>
              Step {s.n}: {s.title}
            </div>
            <div style={{ color: C.muted, fontSize: "0.85rem", lineHeight: 1.6 }}>{s.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const CpiSection: FC = () => (
  <div>
    <SectionTitle>CPI & Composability</SectionTitle>
    <SectionSubtitle>
      CPI (Cross-Program Invocation) means "your program calls our program." All 11 Butter Options
      instructions are callable via CPI, making the protocol fully composable with Solana DeFi.
    </SectionSubtitle>
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: "1rem",
      }}
    >
      {[
        { title: "Perps Platforms", desc: "One-click hedging via purchase_option. Perps users can buy protective puts directly from the trading interface.", color: C.purple },
        { title: "Lending Protocols", desc: "Accept option tokens as collateral — they're real SPL tokens with readable metadata and deterministic pricing.", color: C.blue },
        { title: "Structured Products", desc: "Vaults can write options automatically via write_option, creating yield strategies like covered calls.", color: C.green },
        { title: "AI Agents", desc: "Read token metadata, compute fair value from Pyth feed, and execute trades — no custom SDK needed. The token is the API.", color: C.gold },
      ].map((c) => (
        <Card key={c.title} borderColor={c.color}>
          <div style={{ fontWeight: 600, color: c.color, fontSize: "0.9rem", marginBottom: "0.4rem" }}>
            {c.title}
          </div>
          <div style={{ color: C.muted, fontSize: "0.8rem", lineHeight: 1.6 }}>{c.desc}</div>
        </Card>
      ))}
    </div>
  </div>
);

const FeesSection: FC = () => (
  <div>
    <SectionTitle>Fee Structure</SectionTitle>
    <SectionSubtitle>
      Simple, transparent fees. Only buyers pay fees — writing, exercising, and canceling are free.
    </SectionSubtitle>
    <Table
      headers={["Transaction", "Fee", "Who Pays", "Destination"]}
      rows={[
        [<Mono>purchase_option</Mono>, "0.5% of premium", "Buyer", "Protocol treasury"],
        [<Mono>buy_resale</Mono>, "0.5% of resale price", "Buyer", "Protocol treasury"],
        [<Mono>write_option</Mono>, "None", "—", "—"],
        [<Mono>exercise_option</Mono>, "None", "—", "—"],
        [<Mono>cancel_option</Mono>, "None", "—", "—"],
      ]}
    />
    <p style={{ color: C.mutedDim, fontSize: "0.8rem" }}>
      Fee rate and treasury address are configurable in <Mono>ProtocolState</Mono>.
    </p>
  </div>
);

const TechTestsSection: FC = () => (
  <div>
    <SectionTitle>Tech Stack & Tests</SectionTitle>
    <SectionSubtitle>
      Built on Solana with Anchor, Token-2022, and Pyth Network. Fully tested with 27 integration
      tests.
    </SectionSubtitle>

    <h3 style={{ color: C.cream, fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem" }}>
      Technical Stack
    </h3>
    <Table
      headers={["Component", "Technology"]}
      rows={[
        ["Blockchain", "Solana (devnet → mainnet)"],
        ["Smart Contract", "Anchor 0.32.1 (Rust)"],
        ["Token Standard", "SPL Token-2022 (TransferHook, PermanentDelegate, MetadataExtension)"],
        ["Rust", "1.89.0"],
        ["Solana CLI", "2.3.0"],
        ["Oracle", "Pyth Network"],
        ["Collateral", "USDC (standard SPL Token program)"],
        ["Frontend", "React + TypeScript + Tailwind CSS"],
        ["Built With", "Claude Code"],
      ]}
    />

    <h3 style={{ color: C.cream, fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem", marginTop: "2rem" }}>
      Test Coverage — 27/27 Passing
    </h3>
    <Table
      headers={["Test Group", "Tests", "Verifies"]}
      rows={[
        ["initialize_protocol", "2", "Setup + double-init prevention"],
        ["create_market", "2", "Creation + parameter validation"],
        ["write_option", "3", "Call, put, insufficient collateral"],
        ["purchase_option", "2", "Premium split + partial fills"],
        ["cancel_option", "2", "Pre-sale cancel + post-sale block"],
        ["Post-expiry suite", "5", "Settlement (ITM/OTM), exercise, expire"],
        ["Resale market", "2", "List + buy resale"],
        ["Partial fills", "3", "Multiple buyers, partial qty"],
        ["Token-2022 extensions", "4", "Transfer hook, metadata, delegate"],
        ["Token-2022 smoke", "2", "Extension init sanity"],
      ]}
    />
  </div>
);

const RoadmapSection: FC = () => {
  const phases = [
    { phase: "1", title: "Core protocol: 11 instructions, isolated escrow, tokenized positions, P2P resale, fees", status: "Complete", color: C.green },
    { phase: "1.5", title: "Living Option Token: Token-2022 with transfer hook, permanent delegate, metadata", status: "Complete", color: C.green },
    { phase: "2", title: "Permissionless assets, asset-class pricing, Black-Scholes improvements, CPI docs", status: "Complete", color: C.green },
    { phase: "2.5", title: "Devnet deployment, frontend, demo video, Colosseum submission", status: "In Progress", color: C.blue },
    { phase: "3", title: "Protocol-managed vaults with 5-layer protection, automated market making", status: "Designed", color: C.purple },
    { phase: "4", title: "Mainnet launch, security audit, institutional integrations", status: "Planned", color: C.amber },
    { phase: "5", title: "Cross-chain, governance token, advanced strategies, AI agent marketplace", status: "Vision", color: C.mutedDim },
  ];

  return (
    <div>
      <SectionTitle>Roadmap</SectionTitle>
      <SectionSubtitle>
        From hackathon prototype to production infrastructure.
      </SectionSubtitle>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {phases.map((p) => (
          <div
            key={p.phase}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1rem",
              background: C.bgCard,
              border: `1px solid ${C.border}`,
              borderRadius: "0.75rem",
              padding: "1rem 1.25rem",
            }}
          >
            <div
              style={{
                minWidth: "3rem",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.85rem",
                fontWeight: 700,
                color: C.gold,
              }}
            >
              {p.phase}
            </div>
            <div style={{ flex: 1, color: C.cream, fontSize: "0.85rem", lineHeight: 1.5 }}>
              {p.title}
            </div>
            <Badge color={p.color}>{p.status}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main DocsPage component
// ---------------------------------------------------------------------------
export const DocsPage: FC = () => {
  const [activeSection, setActiveSection] = useState("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Scroll spy
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const handleScroll = () => {
      const sections = SECTIONS.map((s) => ({
        id: s.id,
        el: document.getElementById(s.id),
      })).filter((s) => s.el);

      let current = "overview";
      for (const s of sections) {
        if (s.el) {
          const rect = s.el.getBoundingClientRect();
          if (rect.top <= 140) current = s.id;
        }
      }
      setActiveSection(current);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveSection(id);
      setSidebarOpen(false);
    }
  };

  const SECTION_COMPONENTS: Record<string, FC> = {
    overview: OverviewSection,
    "living-token": LivingTokenSection,
    instructions: InstructionsSection,
    accounts: AccountsSection,
    "any-asset": AnyAssetSection,
    security: SecuritySection,
    lifecycle: LifecycleSection,
    cpi: CpiSection,
    fees: FeesSection,
    "tech-tests": TechTestsSection,
    roadmap: RoadmapSection,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        fontFamily: "'Instrument Sans', 'Inter', system-ui, sans-serif",
        paddingTop: "4rem", // header offset
      }}
    >
      {/* Google Fonts */}
      <link
        href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
        rel="stylesheet"
      />

      {/* Mobile sidebar toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        style={{
          display: "none",
          position: "fixed",
          bottom: "1.5rem",
          right: "1.5rem",
          zIndex: 60,
          width: "3rem",
          height: "3rem",
          borderRadius: "50%",
          background: C.gold,
          color: C.bg,
          border: "none",
          fontSize: "1.25rem",
          cursor: "pointer",
          boxShadow: `0 4px 20px ${C.gold}40`,
          alignItems: "center",
          justifyContent: "center",
        }}
        className="docs-mobile-toggle"
      >
        ☰
      </button>

      {/* Sidebar overlay for mobile */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 49,
          }}
          className="docs-sidebar-overlay"
        />
      )}

      {/* Sidebar */}
      <aside
        style={{
          position: "fixed",
          top: "4rem",
          left: 0,
          bottom: 0,
          width: "260px",
          background: C.bgSidebar,
          borderRight: `1px solid ${C.border}`,
          overflowY: "auto",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          transition: "transform 0.3s ease",
        }}
        className={`docs-sidebar ${sidebarOpen ? "docs-sidebar-open" : ""}`}
      >
        <div style={{ padding: "1.5rem 1.25rem 1rem" }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: "1.1rem",
              color: C.gold,
              fontFamily: "'Instrument Sans', 'Inter', system-ui, sans-serif",
              letterSpacing: "0.05em",
            }}
          >
            BUTTER
          </div>
          <div style={{ fontSize: "0.75rem", color: C.mutedDim, marginTop: "0.15rem" }}>
            Protocol Docs
          </div>
        </div>

        <nav style={{ flex: 1, padding: "0 0.5rem" }}>
          {SECTIONS.map((s) => {
            const isActive = activeSection === s.id;
            return (
              <button
                key={s.id}
                onClick={() => scrollTo(s.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.65rem",
                  width: "100%",
                  padding: "0.6rem 0.75rem",
                  marginBottom: "0.15rem",
                  border: "none",
                  borderLeft: isActive ? `2px solid ${C.gold}` : "2px solid transparent",
                  borderRadius: "0 0.5rem 0.5rem 0",
                  background: isActive ? C.goldGlow : "transparent",
                  color: isActive ? C.gold : C.muted,
                  fontSize: "0.82rem",
                  fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "'Instrument Sans', 'Inter', system-ui, sans-serif",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = C.bgCardHover;
                    e.currentTarget.style.color = C.cream;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = C.muted;
                  }
                }}
              >
                <span style={{ fontSize: "0.9rem", width: "1.2rem", textAlign: "center" }}>
                  {s.icon}
                </span>
                {s.label}
              </button>
            );
          })}
        </nav>

        {/* Program ID at bottom */}
        <div
          style={{
            padding: "1rem 1.25rem",
            borderTop: `1px solid ${C.border}`,
            fontSize: "0.6rem",
            fontFamily: "'JetBrains Mono', monospace",
            color: C.mutedDim,
            lineHeight: 1.6,
          }}
        >
          <div style={{ marginBottom: "0.25rem" }}>Program ID</div>
          <div style={{ color: C.muted, wordBreak: "break-all" }}>CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq</div>
        </div>
      </aside>

      {/* Main content */}
      <div
        ref={contentRef}
        style={{
          marginLeft: "260px",
          padding: "2rem 3rem 4rem",
          maxWidth: "900px",
        }}
        className="docs-content"
      >
        {SECTIONS.map((s) => {
          const Component = SECTION_COMPONENTS[s.id];
          return (
            <section
              key={s.id}
              id={s.id}
              style={{
                marginBottom: "4rem",
                scrollMarginTop: "5rem",
              }}
            >
              <Component />
            </section>
          );
        })}

        {/* Footer */}
        <div
          style={{
            borderTop: `1px solid ${C.border}`,
            paddingTop: "2rem",
            textAlign: "center",
            color: C.mutedDim,
            fontSize: "0.8rem",
          }}
        >
          Built with Claude Code. No traditional development team required.
        </div>
      </div>

      {/* Responsive styles */}
      <style>{`
        @media (max-width: 768px) {
          .docs-sidebar {
            transform: translateX(-100%);
          }
          .docs-sidebar-open {
            transform: translateX(0) !important;
          }
          .docs-mobile-toggle {
            display: flex !important;
          }
          .docs-content {
            margin-left: 0 !important;
            padding: 1.5rem 1rem 3rem !important;
          }
        }
      `}</style>
    </div>
  );
};
