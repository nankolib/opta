// =============================================================================
// tests/token2022-smoke.ts — Minimal Token-2022 extension smoke test
// =============================================================================
// Verifies that our Solana version stack supports creating a Token-2022 mint
// with TransferHook, PermanentDelegate, and MetadataPointer extensions.
// If this fails with InvalidAccountData, we have a version mismatch.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createInitializeTransferHookInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  getMintLen,
} from "@solana/spl-token";
import { assert } from "chai";

describe("token2022-smoke", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const payer = (provider.wallet as any).payer as Keypair;

  it("creates a Token-2022 mint with TransferHook + PermanentDelegate + MetadataPointer", async () => {
    const mintKeypair = Keypair.generate();
    const mintAuthority = payer.publicKey;
    const decimals = 0;

    // Dummy hook program and permanent delegate
    const hookProgramId = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
    const permanentDelegate = payer.publicKey;

    // Calculate space for the mint with all three extensions
    const extensions = [
      ExtensionType.TransferHook,
      ExtensionType.PermanentDelegate,
      ExtensionType.MetadataPointer,
    ];
    const mintLen = getMintLen(extensions);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

    // Build the transaction:
    // 1. Create account with enough space
    // 2. Initialize TransferHook extension
    // 3. Initialize PermanentDelegate extension
    // 4. Initialize MetadataPointer extension
    // 5. InitializeMint2
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mintKeypair.publicKey,
        mintAuthority,
        hookProgramId,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializePermanentDelegateInstruction(
        mintKeypair.publicKey,
        permanentDelegate,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMetadataPointerInstruction(
        mintKeypair.publicKey,
        mintAuthority,
        mintKeypair.publicKey, // metadata stored on the mint itself
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMint2Instruction(
        mintKeypair.publicKey,
        decimals,
        mintAuthority,
        null, // no freeze authority
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    const sig = await sendAndConfirmTransaction(
      provider.connection,
      tx,
      [payer, mintKeypair],
      { commitment: "confirmed" },
    );

    console.log("    Token-2022 mint created:", mintKeypair.publicKey.toBase58());
    console.log("    tx:", sig);

    // Verify the mint exists and is owned by Token-2022 program
    const mintInfo = await provider.connection.getAccountInfo(mintKeypair.publicKey);
    assert.ok(mintInfo, "Mint account should exist");
    assert.ok(mintInfo!.owner.equals(TOKEN_2022_PROGRAM_ID), "Mint should be owned by Token-2022 program");
    assert.equal(mintInfo!.data.length, mintLen, "Mint data length should match expected size with extensions");

    console.log("    ✓ Token-2022 mint with 3 extensions created successfully!");
  });

  it("creates mint with exact base size, then initializes metadata (realloc approach)", async () => {
    // Strategy: create with exact base extension size, overfund with lamports,
    // then let metadata initialize handle the realloc
    const mintKeypair = Keypair.generate();
    const mintAuthority = payer.publicKey;
    const decimals = 0;

    const hookProgramId = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
    const permanentDelegate = payer.publicKey;

    const extensions = [
      ExtensionType.TransferHook,
      ExtensionType.PermanentDelegate,
      ExtensionType.MetadataPointer,
    ];
    const baseMintLen = getMintLen(extensions);
    // Fund for full size (with metadata headroom) but only allocate base
    const fullFundedSize = baseMintLen + 854;
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(fullFundedSize);

    console.log("    baseMintLen:", baseMintLen, "funded for:", fullFundedSize);

    // Step 1: Create account with exact base size, extensions, and InitializeMint2
    const tx1 = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: baseMintLen,  // exact base size, NOT baseMintLen + 854
        lamports,            // but overfunded for future realloc
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mintKeypair.publicKey, mintAuthority, hookProgramId, TOKEN_2022_PROGRAM_ID,
      ),
      createInitializePermanentDelegateInstruction(
        mintKeypair.publicKey, permanentDelegate, TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMetadataPointerInstruction(
        mintKeypair.publicKey, mintAuthority, mintKeypair.publicKey, TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMint2Instruction(
        mintKeypair.publicKey, decimals, mintAuthority, null, TOKEN_2022_PROGRAM_ID,
      ),
    );

    await sendAndConfirmTransaction(
      provider.connection, tx1, [payer, mintKeypair], { commitment: "confirmed" },
    );
    console.log("    ✓ Step 1: Mint created with exact base size + InitializeMint2 succeeded");

    // Step 2: Initialize metadata (should auto-realloc since overfunded)
    const { createInitializeInstruction } = await import("@solana/spl-token-metadata");
    const tx2 = new Transaction().add(
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mintKeypair.publicKey,
        updateAuthority: mintAuthority,
        mint: mintKeypair.publicKey,
        mintAuthority: mintAuthority,
        name: "BUTTER-SOL-200C-APR15",
        symbol: "bOPT",
        uri: "",
      }),
    );

    try {
      await sendAndConfirmTransaction(
        provider.connection, tx2, [payer], { commitment: "confirmed" },
      );
      console.log("    ✓ Step 2: Metadata initialized via auto-realloc");
    } catch (err: any) {
      console.log("    ✗ Step 2 failed:", err.message?.slice(0, 200));
      throw err;
    }
  });
});
