/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/opta.json`.
 */
export type Opta = {
  "address": "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq",
  "metadata": {
    "name": "opta",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "autoFinalizeHolders",
      "docs": [
        "Auto-burn holder option tokens + auto-pay ITM USDC for a settled vault.",
        "Permissionless. Caller passes `remaining_accounts` as pairs of",
        "(holder_option_ata, holder_usdc_ata). Idempotent: zero-amount accounts",
        "and mismatched USDC ATAs are skipped silently.",
        "See docs/AUTO_FINALIZE_PLAN.md."
      ],
      "discriminator": [
        137,
        143,
        14,
        164,
        172,
        162,
        193,
        160
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless caller — pays the tx fee. Not stored anywhere."
          ],
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The settled shared vault."
          ],
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "The vault's market — pinned to the vault for sanity, not read in handler."
          ]
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "Per-mint tracking record. Pins option_mint to this vault so callers",
            "can't pass an unrelated mint with a matching vault."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "The Token-2022 option mint being burned from. Must be `mut` so the",
            "burn CPI can decrement `supply` on the mint account."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account — payout source."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — PermanentDelegate authority on every option mint.",
            "Signs as `[b\"protocol_v2\", &[bump]]` to authorize the burns."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program — for burning option tokens."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program — for USDC transfers from vault → holder."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "burnUnsoldFromVault",
      "docs": [
        "Burn unsold option tokens from a vault mint, freeing committed collateral."
      ],
      "discriminator": [
        253,
        42,
        59,
        81,
        189,
        233,
        249,
        40
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer burning their unsold tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in the vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record for this specific mint."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — signs as purchase escrow owner for the burn."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "optionMint",
          "docs": [
            "The Token-2022 option mint being burned."
          ],
          "writable": true
        },
        {
          "name": "purchaseEscrow",
          "docs": [
            "Purchase escrow holding the unsold tokens."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  112,
                  117,
                  114,
                  99,
                  104,
                  97,
                  115,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.writer",
                "account": "vaultMint"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.created_at",
                "account": "vaultMint"
              }
            ]
          }
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": []
    },
    {
      "name": "claimPremium",
      "docs": [
        "Claim earned premium from a shared vault."
      ],
      "discriminator": [
        225,
        124,
        12,
        107,
        24,
        154,
        37,
        100
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer claiming premium."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in the vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC token account — source of premium."
          ],
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC token account — destination."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "createMarket",
      "docs": [
        "Register a supported asset (permissionless, idempotent).",
        "One Market PDA per asset; strike/expiry/type live on SharedVault.",
        "`pyth_feed_id` is the 32-byte Pyth Pull feed ID for the asset."
      ],
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "creator",
          "docs": [
            "Permissionless — anyone can call. Pays for account creation on",
            "first init; pays nothing on idempotent re-call because",
            "`init_if_needed` short-circuits when the account already exists."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Global ProtocolState — mutated to bump total_markets on first init."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Asset registry PDA. One per supported asset."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "assetName"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "assetName",
          "type": "string"
        },
        {
          "name": "pythFeedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "assetClass",
          "type": "u8"
        }
      ]
    },
    {
      "name": "createSharedVault",
      "docs": [
        "Create a new shared collateral vault for a specific option specification."
      ],
      "discriminator": [
        152,
        55,
        207,
        92,
        82,
        162,
        20,
        84
      ],
      "accounts": [
        {
          "name": "creator",
          "docs": [
            "The vault creator (first writer). Pays for account creation."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "docs": [
            "The OptionsMarket this vault is for. Must exist and be active."
          ]
        },
        {
          "name": "sharedVault",
          "docs": [
            "The SharedVault PDA — unique per (market, strike, expiry, option_type)."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "The vault's USDC token account. Authority = shared_vault PDA.",
            "This holds all the collateral deposited by writers."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  117,
                  115,
                  100,
                  99
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "USDC mint — validated against the protocol's stored USDC mint."
          ]
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "epochConfig",
          "docs": [
            "Epoch config — required for Epoch vaults, optional for Custom.",
            "When present, used to validate the expiry aligns with the epoch schedule."
          ],
          "optional": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program — for the USDC token account."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "strikePrice",
          "type": "u64"
        },
        {
          "name": "expiry",
          "type": "i64"
        },
        {
          "name": "optionType",
          "type": {
            "defined": {
              "name": "optionType"
            }
          }
        },
        {
          "name": "vaultType",
          "type": {
            "defined": {
              "name": "vaultType"
            }
          }
        },
        {
          "name": "collateralMint",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "depositToVault",
      "docs": [
        "Deposit USDC collateral into a shared vault and receive shares."
      ],
      "discriminator": [
        18,
        62,
        110,
        8,
        26,
        106,
        248,
        151
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer depositing collateral."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The vault to deposit into. Must not be settled or expired."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in this vault. Created on first deposit (init_if_needed)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC token account — source of collateral."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC token account — destination for collateral."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program — for USDC transfers."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "exerciseFromVault",
      "docs": [
        "Exercise option tokens from a settled vault."
      ],
      "discriminator": [
        236,
        119,
        0,
        19,
        99,
        94,
        191,
        116
      ],
      "accounts": [
        {
          "name": "holder",
          "docs": [
            "The option token holder exercising their tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The settled shared vault."
          ],
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "The market — for settlement verification."
          ]
        },
        {
          "name": "vaultMintRecord"
        },
        {
          "name": "optionMint",
          "docs": [
            "The Token-2022 option mint."
          ],
          "writable": true
        },
        {
          "name": "holderOptionAccount",
          "docs": [
            "Holder's option token account (Token-2022)."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account — payout source."
          ],
          "writable": true
        },
        {
          "name": "holderUsdcAccount",
          "docs": [
            "Holder's USDC account — receives payout."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program — for burning option tokens."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program — for USDC transfers."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeEpochConfig",
      "docs": [
        "Initialize the epoch schedule (admin-only, one-time setup)."
      ],
      "discriminator": [
        224,
        171,
        134,
        64,
        85,
        90,
        160,
        246
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Protocol admin — must match protocol_state.admin."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — used to verify the admin."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "epochConfig",
          "docs": [
            "The epoch config PDA — created once, never recreated."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  112,
                  111,
                  99,
                  104,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "weeklyExpiryDay",
          "type": "u8"
        },
        {
          "name": "weeklyExpiryHour",
          "type": "u8"
        },
        {
          "name": "monthlyEnabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "initializeProtocol",
      "discriminator": [
        188,
        233,
        252,
        106,
        134,
        146,
        202,
        91
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin who is initializing the protocol. They pay for account rent",
            "and become the protocol admin."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "ProtocolState PDA — the global config singleton.",
            "`init` means Anchor will create this account. If it already exists,",
            "the transaction fails (preventing double-initialization)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "docs": [
            "Treasury — a USDC token account owned by the protocol PDA.",
            "This is where protocol fees accumulate."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "The USDC mint account. On devnet, this is a test mint."
          ]
        },
        {
          "name": "systemProgram",
          "docs": [
            "Required system programs for account creation."
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "migratePythFeed",
      "docs": [
        "Rotate the Pyth Pull feed_id stored on an existing OptionsMarket.",
        "Admin-only; idempotent on same feed_id; overwrites on different.",
        "No oracle call — only mutates registry metadata."
      ],
      "discriminator": [
        30,
        207,
        203,
        67,
        14,
        109,
        162,
        226
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Must match `protocol_state.admin`. Verified in the handler."
          ],
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Global ProtocolState — read-only here, used to verify the admin key."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "The market whose Pyth feed_id is being rotated. PDA seeds enforce",
            "existence — passing an unknown asset_name fails seed validation",
            "(AccountNotInitialized)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "assetName"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "assetName",
          "type": "string"
        },
        {
          "name": "newPythFeedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "mintFromVault",
      "docs": [
        "Mint Living Option Tokens from a shared vault using writer's collateral share."
      ],
      "discriminator": [
        233,
        68,
        207,
        77,
        60,
        175,
        102,
        132
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer minting option tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault providing collateral backing."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in the vault — validates ownership and available collateral."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "The OptionsMarket — for strike price, expiry, asset info in metadata."
          ]
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — mint authority and permanent delegate for Token-2022."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "optionMint",
          "docs": [
            "Token-2022 mint for the option tokens — created manually via CPI."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  111,
                  112,
                  116,
                  105,
                  111,
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              },
              {
                "kind": "arg",
                "path": "createdAt"
              }
            ]
          }
        },
        {
          "name": "purchaseEscrow",
          "docs": [
            "Purchase escrow — holds minted tokens until buyers purchase."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  112,
                  117,
                  114,
                  99,
                  104,
                  97,
                  115,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              },
              {
                "kind": "arg",
                "path": "createdAt"
              }
            ]
          }
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record — tracks premium, quantity, and sold count per mint."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "optionMint"
              }
            ]
          }
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "The transfer hook program — for initializing hook state."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList PDA — created by the hook program during CPI."
          ],
          "writable": true
        },
        {
          "name": "hookState",
          "docs": [
            "HookState PDA — stores expiry + protocol PDA for the transfer hook."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program — for the option mint and token accounts."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "premiumPerContract",
          "type": "u64"
        },
        {
          "name": "createdAt",
          "type": "i64"
        }
      ]
    },
    {
      "name": "purchaseFromVault",
      "docs": [
        "Purchase option tokens minted from a shared vault."
      ],
      "discriminator": [
        155,
        113,
        57,
        45,
        72,
        199,
        72,
        29
      ],
      "accounts": [
        {
          "name": "buyer",
          "docs": [
            "The buyer purchasing option tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault this purchase is from."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "The writer's position — for tracking options_sold."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.writer",
                "account": "vaultMint"
              }
            ]
          }
        },
        {
          "name": "vaultMintRecord",
          "docs": [
            "VaultMint record — holds premium_per_contract and quantity tracking."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — for fee_bps, volume tracking, and token transfer signing."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "The OptionsMarket — for expiry validation."
          ]
        },
        {
          "name": "optionMint",
          "docs": [
            "Option token mint (Token-2022)."
          ]
        },
        {
          "name": "purchaseEscrow",
          "docs": [
            "Purchase escrow holding unsold tokens (Token-2022 account)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  112,
                  117,
                  114,
                  99,
                  104,
                  97,
                  115,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.writer",
                "account": "vaultMint"
              },
              {
                "kind": "account",
                "path": "vault_mint_record.created_at",
                "account": "vaultMint"
              }
            ]
          }
        },
        {
          "name": "buyerOptionAccount",
          "docs": [
            "Buyer's option token account (Token-2022). Frontend creates ATA before calling."
          ],
          "writable": true
        },
        {
          "name": "buyerUsdcAccount",
          "docs": [
            "Buyer's USDC account — pays premium from here."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC account — receives writer's share of premium."
          ],
          "writable": true
        },
        {
          "name": "treasury",
          "docs": [
            "Treasury — receives protocol fee."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program — for USDC transfers."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program — for option token transfers."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "Transfer hook program."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList for the transfer hook."
          ]
        },
        {
          "name": "hookState",
          "docs": [
            "HookState with expiry info for the transfer hook."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "maxPremium",
          "type": "u64"
        }
      ]
    },
    {
      "name": "settleExpiry",
      "docs": [
        "Record the canonical settlement price for an (asset, expiry) tuple",
        "from a Pyth Pull `PriceUpdateV2` account. Permissionless — anyone",
        "can call once the (asset, expiry) is past expiry and a fresh Pyth",
        "update is on-chain."
      ],
      "discriminator": [
        75,
        119,
        150,
        43,
        240,
        9,
        203,
        127
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless. Caller pays for SettlementRecord rent."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "docs": [
            "OptionsMarket — provides the canonical feed_id for this asset."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "assetName"
              }
            ]
          }
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Fresh PriceUpdateV2 from the Pyth Receiver program. Validated by",
            "`get_price_no_older_than(.., &market.pyth_feed_id)` for both feed_id",
            "match and staleness."
          ]
        },
        {
          "name": "settlementRecord",
          "docs": [
            "The SettlementRecord PDA. Plain `init` — second call for the same",
            "(asset, expiry) reverts."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "assetName"
              },
              {
                "kind": "arg",
                "path": "expiry"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "assetName",
          "type": "string"
        },
        {
          "name": "expiry",
          "type": "i64"
        }
      ]
    },
    {
      "name": "settleVault",
      "docs": [
        "Settle a shared vault. Permissionless — reads the canonical price",
        "from a SettlementRecord PDA written earlier by `settle_expiry`."
      ],
      "discriminator": [
        43,
        37,
        36,
        63,
        170,
        246,
        191,
        230
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Permissionless — anyone can settle a vault once the SettlementRecord",
            "for its (asset, expiry) exists."
          ],
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault to settle."
          ],
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "The vault's market — needed to derive the SettlementRecord PDA from",
            "`market.asset_name`. Constraint pins it to the vault's recorded market."
          ]
        },
        {
          "name": "settlementRecord",
          "docs": [
            "The canonical settlement record for this (asset, expiry). If none",
            "exists, anchor's seed validation + Account deserialization fails",
            "before the handler runs."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.asset_name",
                "account": "optionsMarket"
              },
              {
                "kind": "account",
                "path": "shared_vault.expiry",
                "account": "sharedVault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "withdrawFromVault",
      "docs": [
        "Withdraw uncommitted collateral from a shared vault."
      ],
      "discriminator": [
        180,
        34,
        37,
        46,
        156,
        0,
        211,
        238
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer withdrawing collateral."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The shared vault."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position in the vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC token account — source of withdrawal."
          ],
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC token account — destination."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "sharesToWithdraw",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawPostSettlement",
      "docs": [
        "Withdraw remaining collateral after vault settlement."
      ],
      "discriminator": [
        158,
        88,
        59,
        220,
        107,
        159,
        41,
        44
      ],
      "accounts": [
        {
          "name": "writer",
          "docs": [
            "The writer withdrawing remaining collateral."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sharedVault",
          "docs": [
            "The settled shared vault."
          ],
          "writable": true
        },
        {
          "name": "writerPosition",
          "docs": [
            "Writer's position — will be closed after withdrawal."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sharedVault"
              },
              {
                "kind": "account",
                "path": "writer"
              }
            ]
          }
        },
        {
          "name": "vaultUsdcAccount",
          "docs": [
            "Vault's USDC token account."
          ],
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC token account — destination."
          ],
          "writable": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — for USDC mint validation."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "epochConfig",
      "discriminator": [
        190,
        66,
        87,
        197,
        214,
        153,
        144,
        193
      ]
    },
    {
      "name": "optionsMarket",
      "discriminator": [
        67,
        30,
        90,
        36,
        130,
        219,
        166,
        8
      ]
    },
    {
      "name": "priceUpdateV2",
      "discriminator": [
        34,
        241,
        35,
        99,
        157,
        126,
        244,
        205
      ]
    },
    {
      "name": "protocolState",
      "discriminator": [
        33,
        51,
        173,
        134,
        35,
        140,
        195,
        248
      ]
    },
    {
      "name": "settlementRecord",
      "discriminator": [
        172,
        159,
        67,
        74,
        96,
        85,
        37,
        205
      ]
    },
    {
      "name": "sharedVault",
      "discriminator": [
        195,
        36,
        66,
        128,
        41,
        62,
        161,
        142
      ]
    },
    {
      "name": "vaultMint",
      "discriminator": [
        219,
        139,
        146,
        175,
        62,
        90,
        224,
        254
      ]
    },
    {
      "name": "writerPosition",
      "discriminator": [
        195,
        252,
        56,
        77,
        221,
        13,
        8,
        69
      ]
    }
  ],
  "events": [
    {
      "name": "holdersFinalized",
      "discriminator": [
        201,
        31,
        130,
        144,
        98,
        150,
        173,
        199
      ]
    },
    {
      "name": "marketSettled",
      "discriminator": [
        237,
        212,
        22,
        175,
        201,
        117,
        215,
        99
      ]
    },
    {
      "name": "optionCancelled",
      "discriminator": [
        200,
        7,
        36,
        77,
        69,
        191,
        174,
        148
      ]
    },
    {
      "name": "optionExercised",
      "discriminator": [
        34,
        100,
        89,
        14,
        247,
        159,
        22,
        97
      ]
    },
    {
      "name": "optionExpired",
      "discriminator": [
        164,
        0,
        177,
        167,
        225,
        148,
        88,
        250
      ]
    },
    {
      "name": "optionListedForResale",
      "discriminator": [
        72,
        5,
        23,
        201,
        179,
        134,
        149,
        31
      ]
    },
    {
      "name": "optionPurchased",
      "discriminator": [
        9,
        175,
        211,
        168,
        31,
        202,
        39,
        191
      ]
    },
    {
      "name": "optionResold",
      "discriminator": [
        24,
        199,
        191,
        176,
        131,
        186,
        52,
        64
      ]
    },
    {
      "name": "optionWritten",
      "discriminator": [
        216,
        89,
        143,
        186,
        129,
        212,
        10,
        147
      ]
    },
    {
      "name": "premiumClaimed",
      "discriminator": [
        60,
        221,
        78,
        168,
        150,
        45,
        78,
        169
      ]
    },
    {
      "name": "resaleCancelled",
      "discriminator": [
        136,
        250,
        89,
        243,
        72,
        144,
        231,
        75
      ]
    },
    {
      "name": "vaultBurnUnsold",
      "discriminator": [
        157,
        246,
        255,
        145,
        235,
        202,
        218,
        246
      ]
    },
    {
      "name": "vaultCreated",
      "discriminator": [
        117,
        25,
        120,
        254,
        75,
        236,
        78,
        115
      ]
    },
    {
      "name": "vaultDeposited",
      "discriminator": [
        59,
        62,
        43,
        200,
        220,
        104,
        100,
        67
      ]
    },
    {
      "name": "vaultExercised",
      "discriminator": [
        130,
        23,
        134,
        202,
        255,
        53,
        104,
        154
      ]
    },
    {
      "name": "vaultMinted",
      "discriminator": [
        255,
        29,
        220,
        47,
        251,
        229,
        64,
        246
      ]
    },
    {
      "name": "vaultPostSettlementWithdraw",
      "discriminator": [
        40,
        198,
        199,
        220,
        212,
        121,
        133,
        228
      ]
    },
    {
      "name": "vaultPurchased",
      "discriminator": [
        106,
        70,
        42,
        129,
        49,
        102,
        91,
        78
      ]
    },
    {
      "name": "vaultSettled",
      "discriminator": [
        203,
        151,
        101,
        220,
        6,
        59,
        48,
        30
      ]
    },
    {
      "name": "vaultWithdrawn",
      "discriminator": [
        238,
        9,
        219,
        172,
        188,
        77,
        72,
        104
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Unauthorized: signer is not the protocol admin"
    },
    {
      "code": 6001,
      "name": "expiryInPast",
      "msg": "Expiry timestamp must be in the future"
    },
    {
      "code": 6002,
      "name": "invalidStrikePrice",
      "msg": "Strike price must be greater than zero"
    },
    {
      "code": 6003,
      "name": "invalidAssetName",
      "msg": "Asset name must be 1-16 ASCII uppercase letters or digits"
    },
    {
      "code": 6004,
      "name": "invalidAssetClass",
      "msg": "Asset class must be 0-4 (crypto, commodity, equity, forex, etf)"
    },
    {
      "code": 6005,
      "name": "assetMismatch",
      "msg": "Market already exists for this asset with different metadata"
    },
    {
      "code": 6006,
      "name": "marketNotExpired",
      "msg": "Market has not expired yet"
    },
    {
      "code": 6007,
      "name": "marketNotSettled",
      "msg": "Market has not been settled yet"
    },
    {
      "code": 6008,
      "name": "invalidSettlementPrice",
      "msg": "Settlement price must be greater than zero"
    },
    {
      "code": 6009,
      "name": "unsupportedCollateral",
      "msg": "Collateral mint must be the protocol's USDC mint"
    },
    {
      "code": 6010,
      "name": "insufficientCollateral",
      "msg": "Insufficient collateral for this option"
    },
    {
      "code": 6011,
      "name": "invalidContractSize",
      "msg": "Contract size must be greater than zero"
    },
    {
      "code": 6012,
      "name": "invalidPremium",
      "msg": "Premium must be greater than zero"
    },
    {
      "code": 6013,
      "name": "notWriter",
      "msg": "Only the writer can perform this action"
    },
    {
      "code": 6014,
      "name": "cannotBuyOwnOption",
      "msg": "Cannot buy your own option"
    },
    {
      "code": 6015,
      "name": "insufficientOptionTokens",
      "msg": "Insufficient option tokens to exercise"
    },
    {
      "code": 6016,
      "name": "optionExpired",
      "msg": "Option has already expired — cannot price"
    },
    {
      "code": 6017,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6018,
      "name": "customVaultSingleWriter",
      "msg": "Custom vaults only allow the original creator to deposit"
    },
    {
      "code": 6019,
      "name": "vaultAlreadySettled",
      "msg": "Vault has been settled, no more deposits allowed"
    },
    {
      "code": 6020,
      "name": "vaultExpired",
      "msg": "Vault expiry has passed"
    },
    {
      "code": 6021,
      "name": "invalidEpochExpiry",
      "msg": "Invalid epoch expiry - must fall on configured day and hour"
    },
    {
      "code": 6022,
      "name": "insufficientVaultCollateral",
      "msg": "Insufficient free collateral in writer's vault position"
    },
    {
      "code": 6023,
      "name": "collateralCommitted",
      "msg": "Collateral is committed to active options and cannot be withdrawn"
    },
    {
      "code": 6024,
      "name": "noTokensToBurn",
      "msg": "No unsold tokens to burn"
    },
    {
      "code": 6025,
      "name": "nothingToClaim",
      "msg": "Nothing to claim - all premium already withdrawn"
    },
    {
      "code": 6026,
      "name": "slippageExceeded",
      "msg": "Premium exceeds buyer's maximum (slippage protection)"
    },
    {
      "code": 6027,
      "name": "vaultNotSettled",
      "msg": "Vault not yet settled"
    },
    {
      "code": 6028,
      "name": "optionNotInTheMoney",
      "msg": "Option is not in the money - cannot exercise"
    },
    {
      "code": 6029,
      "name": "invalidVaultMint",
      "msg": "Option mint does not belong to this vault"
    },
    {
      "code": 6030,
      "name": "claimPremiumFirst",
      "msg": "Claim all premium before withdrawing shares"
    },
    {
      "code": 6031,
      "name": "invalidBatchAccounts",
      "msg": "remaining_accounts length must be a multiple of 2 (holder_option_ata, holder_usdc_ata pairs)"
    }
  ],
  "types": [
    {
      "name": "epochConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Who can modify the epoch schedule (protocol admin)."
            ],
            "type": "pubkey"
          },
          {
            "name": "weeklyExpiryDay",
            "docs": [
              "Day of week for weekly expiries. 0 = Sunday, 5 = Friday, 6 = Saturday."
            ],
            "type": "u8"
          },
          {
            "name": "weeklyExpiryHour",
            "docs": [
              "Hour (UTC, 0-23) for weekly expiries. Default 8 = 08:00 UTC."
            ],
            "type": "u8"
          },
          {
            "name": "monthlyEnabled",
            "docs": [
              "Whether the last Friday of each month has a separate monthly epoch."
            ],
            "type": "bool"
          },
          {
            "name": "minEpochDurationDays",
            "docs": [
              "Minimum days to expiry for new epoch vaults (e.g., 1 day).",
              "Prevents creating vaults that expire too soon."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holdersFinalized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "holdersProcessed",
            "type": "u32"
          },
          {
            "name": "totalBurned",
            "type": "u64"
          },
          {
            "name": "totalPaidOut",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "marketSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "settlementPrice",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "optionExercised",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "exerciser",
            "type": "pubkey"
          },
          {
            "name": "settlementPrice",
            "type": "u64"
          },
          {
            "name": "pnl",
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "type": "u64"
          },
          {
            "name": "profitable",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "optionExpired",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "optionListedForResale",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "resalePremium",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionPurchased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionResold",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "resalePremium",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionType",
      "docs": [
        "Whether this option is a call (right to buy) or put (right to sell).",
        "Lives on `SharedVault` post-Stage-2; kept here because vaults import it."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "call"
          },
          {
            "name": "put"
          }
        ]
      }
    },
    {
      "name": "optionWritten",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "type": "pubkey"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "contractSize",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "optionsMarket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "assetName",
            "docs": [
              "Human-readable, normalized asset identifier (\"SOL\", \"BTC\", \"AAPL\", ...).",
              "Max 16 chars, ASCII-uppercase, alphanumeric only."
            ],
            "type": "string"
          },
          {
            "name": "pythFeedId",
            "docs": [
              "The 32-byte Pyth Pull oracle feed ID for this asset.",
              "Stage P1: stored without on-chain validation. Stage P2 settle_expiry",
              "will validate this matches the `feed_id` on a passed-in PriceUpdateV2",
              "account via `get_price_no_older_than(.., &feed_id)`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "assetClass",
            "docs": [
              "Asset class for categorizing the underlying asset.",
              "0 = crypto, 1 = commodity, 2 = equity, 3 = forex, 4 = ETF.",
              "Metadata-only today — no surviving on-chain or frontend pricing",
              "logic branches on this value."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "premiumClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceFeedMessage",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "docs": [
              "`FeedId` but avoid the type alias because of compatibility issues with Anchor's `idl-build` feature."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "docs": [
              "The timestamp of this price update in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "prevPublishTime",
            "docs": [
              "The timestamp of the previous price update. This field is intended to allow users to",
              "identify the single unique price update for any moment in time:",
              "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time.",
              "",
              "Note that there may not be such an update while we are migrating to the new message-sending logic,",
              "as some price updates on pythnet may not be sent to other chains (because the message-sending",
              "logic may not have triggered). We can solve this problem by making the message-sending mandatory",
              "(which we can do once publishers have migrated over).",
              "",
              "Additionally, this field may be equal to publish_time if the message is sent on a slot where",
              "where the aggregation was unsuccesful. This problem will go away once all publishers have",
              "migrated over to a recent version of pyth-agent."
            ],
            "type": "i64"
          },
          {
            "name": "emaPrice",
            "type": "i64"
          },
          {
            "name": "emaConf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceUpdateV2",
      "docs": [
        "A price update account. This account is used by the Pyth Receiver program to store a verified price update from a Pyth price feed.",
        "It contains:",
        "- `write_authority`: The write authority for this account. This authority can close this account to reclaim rent or update the account to contain a different price update.",
        "- `verification_level`: The [`VerificationLevel`] of this price update. This represents how many Wormhole guardian signatures have been verified for this price update.",
        "- `price_message`: The actual price update.",
        "- `posted_slot`: The slot at which this price update was posted."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writeAuthority",
            "type": "pubkey"
          },
          {
            "name": "verificationLevel",
            "type": {
              "defined": {
                "name": "verificationLevel"
              }
            }
          },
          {
            "name": "priceMessage",
            "type": {
              "defined": {
                "name": "priceFeedMessage"
              }
            }
          },
          {
            "name": "postedSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "protocolState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "The admin wallet that can update protocol settings.",
              "Set to the signer of the `initialize_protocol` transaction."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "docs": [
              "Fee charged on option purchases, in basis points (1 bps = 0.01%).",
              "Default: 50 bps = 0.50%.",
              "Example: on a 100 USDC premium, the fee is 0.50 USDC."
            ],
            "type": "u16"
          },
          {
            "name": "treasury",
            "docs": [
              "The treasury token account (PDA) that collects protocol fees in USDC."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "docs": [
              "The USDC mint address. Stored so all instructions can validate that",
              "token accounts are denominated in USDC."
            ],
            "type": "pubkey"
          },
          {
            "name": "totalMarkets",
            "docs": [
              "Running count of all markets created. Used for stats/tracking."
            ],
            "type": "u64"
          },
          {
            "name": "totalVolume",
            "docs": [
              "Running total of all USDC volume (premiums + settlements) flowing",
              "through the protocol. Scaled by 10^6 (USDC decimals)."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed, stored so we don't have to recalculate it."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "resaleCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "settlementRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "assetName",
            "docs": [
              "Asset this settlement is for. Matches OptionsMarket.asset_name",
              "(already normalized to ASCII uppercase + alphanumeric by the",
              "market PDA derivation)."
            ],
            "type": "string"
          },
          {
            "name": "expiry",
            "docs": [
              "Unix timestamp of the expiry boundary this settlement records."
            ],
            "type": "i64"
          },
          {
            "name": "settlementPrice",
            "docs": [
              "Canonical settlement price for this (asset, expiry), scaled by 1e6",
              "(USDC decimals). Today this is admin-supplied (Pyth-mocked); in",
              "production it would be read from a Pyth pull-oracle account."
            ],
            "type": "u64"
          },
          {
            "name": "settledAt",
            "docs": [
              "On-chain timestamp at which `settle_expiry` was called. Useful for",
              "audit trails and \"settle was X seconds late\" diagnostics."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "sharedVault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "docs": [
              "Which OptionsMarket this vault belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "optionType",
            "docs": [
              "Call or Put — reuses the existing OptionType enum from market.rs."
            ],
            "type": {
              "defined": {
                "name": "optionType"
              }
            }
          },
          {
            "name": "strikePrice",
            "docs": [
              "Strike price in USDC (6 decimals). Example: $200.00 = 200_000_000."
            ],
            "type": "u64"
          },
          {
            "name": "expiry",
            "docs": [
              "Unix timestamp when all options in this vault expire."
            ],
            "type": "i64"
          },
          {
            "name": "vaultType",
            "docs": [
              "Epoch (shared, Friday expiries) or Custom (single writer, any expiry)."
            ],
            "type": {
              "defined": {
                "name": "vaultType"
              }
            }
          },
          {
            "name": "totalCollateral",
            "docs": [
              "Total USDC locked across all writers in this vault (6 decimals)."
            ],
            "type": "u64"
          },
          {
            "name": "totalShares",
            "docs": [
              "Total shares issued to all writers. First depositor gets 1:1 ratio,",
              "subsequent depositors get proportional shares."
            ],
            "type": "u64"
          },
          {
            "name": "vaultUsdcAccount",
            "docs": [
              "The USDC token account holding this vault's collateral.",
              "Authority = this SharedVault PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "collateralMint",
            "docs": [
              "Stage 3: the mint of the collateral token. USDC-only enforced today",
              "via a runtime check in `create_shared_vault` against",
              "`protocol_state.usdc_mint`. The field exists so every vault is",
              "self-describing — the 6 ATA-mint constraints across vault-context",
              "instructions read from here rather than from protocol_state, which",
              "keeps the door open for per-vault collateral diversification later."
            ],
            "type": "pubkey"
          },
          {
            "name": "totalOptionsMinted",
            "docs": [
              "Total option tokens minted from this vault across all writers."
            ],
            "type": "u64"
          },
          {
            "name": "totalOptionsSold",
            "docs": [
              "Total option tokens that have been purchased by buyers."
            ],
            "type": "u64"
          },
          {
            "name": "netPremiumCollected",
            "docs": [
              "Total premium collected in this vault (USDC, 6 decimals).",
              "FIX L-04: renamed from premium_collected for clarity."
            ],
            "type": "u64"
          },
          {
            "name": "premiumPerShareCumulative",
            "docs": [
              "FIX H-01: Cumulative premium per share, scaled by 1e12.",
              "Implements reward-per-share accumulator pattern to prevent",
              "late-depositor premium dilution."
            ],
            "type": "u128"
          },
          {
            "name": "isSettled",
            "docs": [
              "Whether this vault has been settled after expiry."
            ],
            "type": "bool"
          },
          {
            "name": "settlementPrice",
            "docs": [
              "Final settlement price (0 until settled). Copied from market."
            ],
            "type": "u64"
          },
          {
            "name": "collateralRemaining",
            "docs": [
              "Collateral remaining after settlement payouts. Writers withdraw from this."
            ],
            "type": "u64"
          },
          {
            "name": "creator",
            "docs": [
              "Who created this vault (the first depositor).",
              "For Custom vaults, this is the only allowed depositor."
            ],
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "docs": [
              "When this vault was created."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultBurnUnsold",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "burned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "vaultType",
            "type": "u8"
          },
          {
            "name": "strikePrice",
            "type": "u64"
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "optionType",
            "type": "u8"
          },
          {
            "name": "creator",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "vaultDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "totalCollateral",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultExercised",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "payout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultMint",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Which SharedVault this mint belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "writer",
            "docs": [
              "The writer who created this mint."
            ],
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "docs": [
              "The Token-2022 mint pubkey."
            ],
            "type": "pubkey"
          },
          {
            "name": "premiumPerContract",
            "docs": [
              "Writer's asking price per contract (USDC, 6 decimals).",
              "This is what buyers pay when purchasing from this mint."
            ],
            "type": "u64"
          },
          {
            "name": "quantityMinted",
            "docs": [
              "How many option tokens were originally minted."
            ],
            "type": "u64"
          },
          {
            "name": "quantitySold",
            "docs": [
              "How many option tokens have been sold to buyers."
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "docs": [
              "Timestamp when this mint was created (also used as PDA seed nonce)."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultMinted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "premiumPerContract",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultPostSettlementWithdraw",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultPurchased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "totalPremium",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "settlementPrice",
            "type": "u64"
          },
          {
            "name": "totalPayout",
            "type": "u64"
          },
          {
            "name": "collateralRemaining",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vaultType",
      "docs": [
        "Whether this vault is an epoch (shared) or custom (single-writer) vault."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "epoch"
          },
          {
            "name": "custom"
          }
        ]
      }
    },
    {
      "name": "vaultWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "writer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "verificationLevel",
      "docs": [
        "Pyth price updates are bridged to all blockchains via Wormhole.",
        "Using the price updates on another chain requires verifying the signatures of the Wormhole guardians.",
        "The usual process is to check the signatures for two thirds of the total number of guardians, but this can be cumbersome on Solana because of the transaction size limits,",
        "so we also allow for partial verification.",
        "",
        "This enum represents how much a price update has been verified:",
        "- If `Full`, we have verified the signatures for two thirds of the current guardians.",
        "- If `Partial`, only `num_signatures` guardian signatures have been checked.",
        "",
        "# Warning",
        "Using partially verified price updates is dangerous, as it lowers the threshold of guardians that need to collude to produce a malicious price update."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "partial",
            "fields": [
              {
                "name": "numSignatures",
                "type": "u8"
              }
            ]
          },
          {
            "name": "full"
          }
        ]
      }
    },
    {
      "name": "writerPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "The writer's wallet address."
            ],
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "Which SharedVault this position belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "shares",
            "docs": [
              "Writer's proportional share of the vault.",
              "Used to calculate their cut of premium and remaining collateral."
            ],
            "type": "u64"
          },
          {
            "name": "depositedCollateral",
            "docs": [
              "Total USDC this writer has deposited into the vault.",
              "Tracked for reference — the authoritative value is shares."
            ],
            "type": "u64"
          },
          {
            "name": "premiumClaimed",
            "docs": [
              "How much premium this writer has already claimed.",
              "Prevents double-claiming."
            ],
            "type": "u64"
          },
          {
            "name": "premiumDebt",
            "docs": [
              "FIX H-01: Snapshot of premium_per_share_cumulative at deposit time.",
              "Used in reward-per-share accumulator to prevent late-depositor dilution."
            ],
            "type": "u128"
          },
          {
            "name": "optionsMinted",
            "docs": [
              "Total option tokens this writer has minted from their vault share.",
              "Used to calculate committed collateral (can't withdraw what's backing active options)."
            ],
            "type": "u64"
          },
          {
            "name": "optionsSold",
            "docs": [
              "How many of this writer's minted tokens have been sold to buyers."
            ],
            "type": "u64"
          },
          {
            "name": "depositedAt",
            "docs": [
              "When this position was first created."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    }
  ]
};
