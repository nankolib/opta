// =============================================================================
// tests/bankrun/lifecycle-smoke.test.ts — Stage G Pass 1 risk-retirement smoke
// =============================================================================
// Proves the FULL Opta stack runs under bankrun, staged so a failure pinpoints
// the culprit:
//   A  bootstrap loads both programs; initialize_protocol succeeds.
//   B  create_market (reads Pyth fixture) → init vol_oracle → create EUR vault →
//      deposit → mint → option mint carrying Token-2022 extensions.
//   C  hook fires: purchase_from_vault (escrow→buyer, hook CPI) + a pre-expiry
//      direct holder→holder hooked transfer (hook allows) + a burn.
//   D  setClock past expiry → a post-expiry hooked transfer is BLOCKED by the
//      hook (proves setClock AND hook firing together).
//   E  THE PRIZE: clock past expiry + Pyth EMA fixture → settle_expiry +
//      settle_vault end-to-end (the clock-dependent path Stage-G un-skips need).
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, createBurnInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupBankrun, fundWallet, prebakeMint, prebakeTokenAccount, injectPythFixture,
  getClockUnix, setClockUnix, OPTA_PROGRAM_ID, HOOK_PROGRAM_ID, Harness,
} from "./bootstrap";
import { serializePriceUpdateV2, synthFeedIdHex } from "../_pyth_fixtures";
import { settlePotAccountsFor } from "../shared/settle-pdas";

const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const FEED_HEX = synthFeedIdHex("bankrun-smoke");
const FEED_ID = Array.from(Buffer.from(FEED_HEX, "hex"));
const ASSET = "BANKSMOKE";
const STRIKE_USD = 40;
const SETTLE_PRICE_USD = 50; // ITM call at expiry

function pda(seeds: (Buffer | Uint8Array)[], programId = OPTA_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
function pythBody(priceUsd: number, publishTime: number): Buffer {
  const price = BigInt(priceUsd) * 100_000_000n; // expo -8
  return serializePriceUpdateV2({
    feedIdHex: FEED_HEX, price, conf: 1_000_000n, exponent: -8,
    publishTime: BigInt(publishTime), prevPublishTime: BigInt(publishTime - 1),
    emaPrice: price, emaConf: 1_000_000n,
  });
}

describe("bankrun lifecycle smoke (Stage G Pass 1)", function () {
  this.timeout(120_000);

  let h: Harness;
  let opta: Program<any>;
  const admin = () => h.payer;
  const writer = Keypair.generate();
  const buyer = Keypair.generate();
  const dest2 = Keypair.generate();
  const dest3 = Keypair.generate();
  const usdcMint = Keypair.generate();

  let protocolState: PublicKey, treasury: PublicKey, market: PublicKey, volOracle: PublicKey;
  let vault: PublicKey, vaultUsdc: PublicKey, writerPos: PublicKey;
  let optionMint: PublicKey, escrow: PublicKey, vaultMintRecord: PublicKey;
  let extraMetas: PublicKey, hookState: PublicKey;
  let buyerOptionAta: PublicKey;
  let now0 = 0, expiry = 0;

  before(async () => {
    h = await setupBankrun();
    opta = h.opta;
    // Fund actor wallets (they pay account-init rent under `payer = …` constraints).
    fundWallet(h.context, writer);
    fundWallet(h.context, buyer);
    fundWallet(h.context, dest2);
    fundWallet(h.context, dest3);
    // Pre-bake the USDC mint (admin = mint authority) + funded USDC ATAs.
    prebakeMint(h.context, usdcMint.publicKey, admin().publicKey, 6);

    protocolState = pda([Buffer.from("protocol_v2")]);
    treasury = pda([Buffer.from("treasury_v2")]);
    market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
    volOracle = pda([Buffer.from("vol_oracle"), Buffer.from(FEED_ID)]);
    now0 = await getClockUnix(h.context);
    expiry = now0 + 3600;
  });

  it("A — bootstrap loads both programs + initialize_protocol", async () => {
    await opta.methods.initializeProtocol().accountsStrict({
      admin: admin().publicKey, protocolState, treasury, usdcMint: usdcMint.publicKey,
      systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }).rpc();
    const ps: any = await opta.account.protocolState.fetch(protocolState);
    assert.ok(ps.usdcMint.equals(usdcMint.publicKey), "protocol usdc_mint set");
    // Both programs really loaded (hook is invoked via CPI in Stage B).
    const hookAcct = await h.context.banksClient.getAccount(HOOK_PROGRAM_ID);
    assert.ok(hookAcct && hookAcct.executable, "transfer-hook program loaded + executable");
  });

  it("B — create_market → vol_oracle → EUR vault → deposit → mint (Token-2022 extensions)", async () => {
    // Proof-of-feed fixture for create_market + init_vol_oracle (no freshness gate).
    const feedFixture = Keypair.generate().publicKey;
    injectPythFixture(h.context, feedFixture, pythBody(SETTLE_PRICE_USD, now0));

    await opta.methods.createMarket(ASSET, FEED_ID, 0, 0).accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      creator: admin().publicKey, protocolState, market, priceUpdate: feedFixture,
      systemProgram: SystemProgram.programId,
    }).rpc();

    await opta.methods.initializeVolOracle(FEED_ID, 0, new BN(0)).accountsStrict({
      initializer: admin().publicKey, priceUpdate: feedFixture, volOracle,
      systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    }).rpc();

    const strike = usdc(STRIKE_USD);
    vault = pda([Buffer.from("shared_vault"), market.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8), new BN(expiry).toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
    vaultUsdc = pda([Buffer.from("vault_usdc"), vault.toBuffer()]);
    writerPos = pda([Buffer.from("writer_position"), vault.toBuffer(), writer.publicKey.toBuffer()]);

    // Writer USDC ATA (classic), pre-funded.
    const writerUsdc = getAssociatedTokenAddressSync(usdcMint.publicKey, writer.publicKey, false, TOKEN_PROGRAM_ID);
    prebakeTokenAccount(h.context, writerUsdc, usdcMint.publicKey, writer.publicKey, 1_000_000_000n);

    await opta.methods.createSharedVault(strike, new BN(expiry), { call: {} }, { custom: {} }, usdcMint.publicKey, 0, { european: {} })
      .accountsStrict({
        creator: writer.publicKey, market, sharedVault: vault, vaultUsdcAccount: vaultUsdc,
        usdcMint: usdcMint.publicKey, protocolState, epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([writer]).rpc();

    await opta.methods.depositToVault(usdc(1000)).accountsStrict({
      writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos,
      writerUsdcAccount: writerUsdc, vaultUsdcAccount: vaultUsdc, protocolState,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([writer]).rpc();

    const createdAt = new BN(now0);
    optionMint = pda([Buffer.from("vault_option_mint"), vault.toBuffer(), writer.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)]);
    escrow = pda([Buffer.from("vault_purchase_escrow"), vault.toBuffer(), writer.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)]);
    vaultMintRecord = pda([Buffer.from("vault_mint_record"), optionMint.toBuffer()]);
    extraMetas = pda([Buffer.from("extra-account-metas"), optionMint.toBuffer()], HOOK_PROGRAM_ID);
    hookState = pda([Buffer.from("hook-state"), optionMint.toBuffer()], HOOK_PROGRAM_ID);

    await opta.methods.mintFromVault(new BN(10), usdc(1), createdAt).accountsStrict({
      writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos, market,
      volOracle, protocolState, optionMint, purchaseEscrow: escrow, vaultMintRecord,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })]).signers([writer]).rpc();

    const mintAcct = await h.context.banksClient.getAccount(optionMint);
    assert.ok(mintAcct, "option mint exists");
    assert.ok(mintAcct!.owner.equals(TOKEN_2022_PROGRAM_ID), "option mint owned by Token-2022");
    assert.isAbove(mintAcct!.data.length, 82, "mint has Token-2022 extensions (> base mint size)");
    console.log(`    B: option mint ${optionMint.toBase58()} size=${mintAcct!.data.length}`);
  });

  it("C — hook fires: purchase (escrow→buyer) + pre-expiry holder transfer + burn", async () => {
    buyerOptionAta = getAssociatedTokenAddressSync(optionMint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const buyerUsdc = getAssociatedTokenAddressSync(usdcMint.publicKey, buyer.publicKey, false, TOKEN_PROGRAM_ID);
    prebakeTokenAccount(h.context, buyerUsdc, usdcMint.publicKey, buyer.publicKey, 1_000_000_000n);

    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      admin().publicKey, buyerOptionAta, buyer.publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    await opta.methods.purchaseFromVault(new BN(5), usdc(100)).accountsStrict({
      buyer: buyer.publicKey, sharedVault: vault, writerPosition: writerPos, vaultMintRecord,
      protocolState, market, optionMint, purchaseEscrow: escrow, buyerOptionAccount: buyerOptionAta,
      buyerUsdcAccount: buyerUsdc, vaultUsdcAccount: vaultUsdc, treasury,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState,
      systemProgram: SystemProgram.programId,
    }).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ataIx]).signers([buyer]).rpc();
    console.log("    C: purchase OK (escrow→buyer hooked transfer fired)");

    // Pre-expiry direct holder→holder hooked transfer (hook ALLOWS).
    const dest2Ata = getAssociatedTokenAddressSync(optionMint, dest2.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await sendTx(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
      admin().publicKey, dest2Ata, dest2.publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)));
    await sendTx(new Transaction().add(hookedTransfer(buyerOptionAta, dest2Ata, buyer.publicKey, 2)), [buyer]);
    console.log("    C: pre-expiry holder→holder hooked transfer OK (hook allowed)");

    // Burn (Token-2022 burn — not a transfer; no hook).
    await sendTx(new Transaction().add(createBurnInstruction(
      buyerOptionAta, optionMint, buyer.publicKey, 1, [], TOKEN_2022_PROGRAM_ID)), [buyer]);
    console.log("    C: burn OK");
  });

  it("D — setClock past expiry → post-expiry hooked transfer BLOCKED by hook", async () => {
    await setClockUnix(h.context, expiry + 30);
    const nowClock = await getClockUnix(h.context);
    assert.isAtLeast(nowClock, expiry, "clock advanced past expiry");

    const dest3Ata = getAssociatedTokenAddressSync(optionMint, dest3.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await sendTx(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
      admin().publicKey, dest3Ata, dest3.publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)));

    let blocked = false, err = "";
    try {
      await sendTx(new Transaction().add(hookedTransfer(buyerOptionAta, dest3Ata, buyer.publicKey, 1)), [buyer]);
    } catch (e: any) {
      blocked = true; err = String(e).slice(0, 200);
    }
    console.log(`    D: post-expiry transfer blocked=${blocked} (${err})`);
    assert.isTrue(blocked, "hook must block post-expiry transfer");
  });

  it("E — THE PRIZE: settle_expiry + settle_vault under bankrun (clock past expiry)", async () => {
    // Clock is expiry+30 (from D). Inject a settle fixture publish_time within the
    // [expiry, expiry+60] settlement window.
    const settleFixture = Keypair.generate().publicKey;
    injectPythFixture(h.context, settleFixture, pythBody(SETTLE_PRICE_USD, expiry + 5));
    const settlementRecord = pda([Buffer.from("settlement"), Buffer.from(ASSET), new BN(expiry).toArrayLike(Buffer, "le", 8)]);

    await opta.methods.settleExpiry(ASSET, new BN(expiry)).accountsStrict({
      caller: admin().publicKey, market, priceUpdate: settleFixture,
      settlementRecord, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    }).rpc();
    console.log("    E: settle_expiry OK");

    await opta.methods.settleVault().accountsStrict({
      authority: admin().publicKey, sharedVault: vault, market, settlementRecord,
      ...(await settlePotAccountsFor(opta, market, vault)),
    }).rpc();

    const v: any = await opta.account.sharedVault.fetch(vault);
    console.log(`    E: settle_vault OK — is_settled=${v.isSettled} settlement_price=${v.settlementPrice.toString()}`);
    assert.isTrue(v.isSettled, "vault settled");
    assert.isTrue(new BN(v.settlementPrice).gtn(0), "settlement price recorded");
  });

  // --- helpers --------------------------------------------------------------
  function hookedTransfer(source: PublicKey, dest: PublicKey, owner: PublicKey, amount: number) {
    const ix = createTransferCheckedInstruction(source, optionMint, dest, owner, amount, 0, [], TOKEN_2022_PROGRAM_ID);
    // spl-token addExtraAccountMetasForExecute order: resolved extras (hook_state),
    // then the hook program, then the validate-state (extra-account-metas) PDA.
    ix.keys.push({ pubkey: hookState, isSigner: false, isWritable: false });
    ix.keys.push({ pubkey: HOOK_PROGRAM_ID, isSigner: false, isWritable: false });
    ix.keys.push({ pubkey: extraMetas, isSigner: false, isWritable: false });
    return ix;
  }
  async function sendTx(tx: Transaction, signers: Keypair[] = []) {
    // Prepend a CU bump (Token-2022 transfer + hook CPI exceeds the 200K default).
    const withCu = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(...tx.instructions);
    withCu.feePayer = admin().publicKey;
    withCu.recentBlockhash = h.context.lastBlockhash;
    await h.provider.sendAndConfirm(withCu, signers);
  }
});
