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
      "name": "buyResale",
      "docs": [
        "Buy tokens from a resale listing. amount is how many to buy (partial fills).",
        "FIX M-03: added max_premium for slippage protection."
      ],
      "discriminator": [
        71,
        230,
        159,
        123,
        90,
        231,
        111,
        104
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
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
            "The market this position belongs to — used to check expiry."
          ]
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "resaleEscrow",
          "docs": [
            "Resale escrow holding option tokens (Token-2022 PDA)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  97,
                  108,
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
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "buyerUsdcAccount",
          "writable": true
        },
        {
          "name": "sellerUsdcAccount",
          "writable": true
        },
        {
          "name": "buyerOptionAccount",
          "docs": [
            "Buyer's option token account (Token-2022). Frontend creates ATA before calling."
          ],
          "writable": true
        },
        {
          "name": "optionMint",
          "docs": [
            "Option token mint (Token-2022 mint)."
          ]
        },
        {
          "name": "treasury",
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
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "maxPremium",
          "type": "u64"
        }
      ]
    },
    {
      "name": "cancelOption",
      "docs": [
        "Cancel an unsold option. Burns all tokens, returns collateral."
      ],
      "discriminator": [
        176,
        215,
        7,
        71,
        184,
        200,
        241,
        217
      ],
      "accounts": [
        {
          "name": "writer",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
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
          "name": "position",
          "writable": true
        },
        {
          "name": "escrow",
          "docs": [
            "USDC collateral escrow (standard Token)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                "path": "position.market",
                "account": "optionPosition"
              },
              {
                "kind": "account",
                "path": "position.writer",
                "account": "optionPosition"
              },
              {
                "kind": "account",
                "path": "position.created_at",
                "account": "optionPosition"
              }
            ]
          }
        },
        {
          "name": "purchaseEscrow",
          "docs": [
            "Purchase escrow holding option tokens (Token-2022)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "optionMint",
          "docs": [
            "Option token mint (Token-2022)."
          ],
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token — for USDC operations."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 — for burning option tokens."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": []
    },
    {
      "name": "cancelResale",
      "docs": [
        "Cancel a resale listing. Returns tokens to seller."
      ],
      "discriminator": [
        215,
        11,
        117,
        119,
        200,
        163,
        110,
        66
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
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
          "name": "position",
          "writable": true
        },
        {
          "name": "resaleEscrow",
          "docs": [
            "Resale escrow holding option tokens (Token-2022 PDA)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  97,
                  108,
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
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "sellerOptionAccount",
          "docs": [
            "Seller's option token account (Token-2022, receives tokens back)."
          ],
          "writable": true
        },
        {
          "name": "optionMint",
          "docs": [
            "Option token mint (Token-2022 mint)."
          ]
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
            "The user creating this market. Anyone can create a market — there's no",
            "permissioning. They pay the rent for the new account."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "The global ProtocolState — we need this to increment total_markets."
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
            "The new OptionsMarket PDA.",
            "",
            "Seeds use the asset name as bytes (not an enum discriminant), making",
            "the protocol open to ANY asset. For example:",
            "- \"SOL\" + strike + expiry + Call  → one unique PDA",
            "- \"AAPL\" + strike + expiry + Call → a different PDA",
            "- \"EUR/USD\" + strike + expiry + Put → yet another",
            "",
            "Attempting to create a duplicate combination will fail."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "docs": [
            "Required for creating new accounts."
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "assetName",
          "type": "string"
        },
        {
          "name": "strikePrice",
          "type": "u64"
        },
        {
          "name": "expiryTimestamp",
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
          "name": "pythFeed",
          "type": "pubkey"
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
      "name": "exerciseOption",
      "docs": [
        "Exercise option tokens after settlement. Burns tokens, distributes PnL."
      ],
      "discriminator": [
        231,
        98,
        131,
        183,
        245,
        93,
        122,
        48
      ],
      "accounts": [
        {
          "name": "exerciser",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
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
          "name": "market"
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                "path": "position.market",
                "account": "optionPosition"
              },
              {
                "kind": "account",
                "path": "position.writer",
                "account": "optionPosition"
              },
              {
                "kind": "account",
                "path": "position.created_at",
                "account": "optionPosition"
              }
            ]
          }
        },
        {
          "name": "optionMint",
          "docs": [
            "Option token mint (Token-2022)."
          ],
          "writable": true
        },
        {
          "name": "exerciserOptionAccount",
          "docs": [
            "Exerciser's option token account (Token-2022)."
          ],
          "writable": true
        },
        {
          "name": "exerciserUsdcAccount",
          "docs": [
            "Exerciser's USDC account (receives PnL)."
          ],
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC account (receives remaining collateral)."
          ],
          "writable": true
        },
        {
          "name": "writer",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token — for USDC operations."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 — for burning option tokens."
          ],
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "tokensToExercise",
          "type": "u64"
        }
      ]
    },
    {
      "name": "expireOption",
      "docs": [
        "Expire an unexercised option. Returns collateral to writer."
      ],
      "discriminator": [
        38,
        144,
        3,
        237,
        125,
        177,
        141,
        229
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
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
          "name": "market"
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                "path": "position.market",
                "account": "optionPosition"
              },
              {
                "kind": "account",
                "path": "position.writer",
                "account": "optionPosition"
              },
              {
                "kind": "account",
                "path": "position.created_at",
                "account": "optionPosition"
              }
            ]
          }
        },
        {
          "name": "writerUsdcAccount",
          "writable": true
        },
        {
          "name": "writer",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
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
      "name": "initializePricing",
      "docs": [
        "Create on-chain pricing account for an option position.",
        "Called once per position by the crank bot."
      ],
      "discriminator": [
        33,
        251,
        52,
        215,
        179,
        153,
        55,
        229
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Anyone can create a pricing PDA (pays rent)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "position",
          "docs": [
            "The option position to create pricing for. Must exist and be active."
          ]
        },
        {
          "name": "pricingData",
          "docs": [
            "The pricing PDA. Created here, owned by this program."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  99,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
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
      "name": "listForResale",
      "docs": [
        "List option tokens for resale. token_amount is how many to list."
      ],
      "discriminator": [
        235,
        101,
        201,
        204,
        83,
        163,
        213,
        243
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
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
          "name": "position",
          "writable": true
        },
        {
          "name": "sellerOptionAccount",
          "docs": [
            "Seller's option token account (Token-2022)."
          ],
          "writable": true
        },
        {
          "name": "resaleEscrow",
          "docs": [
            "Resale escrow for holding listed option tokens (Token-2022 PDA).",
            "Created in handler if it doesn't exist yet."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  97,
                  108,
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
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "optionMint",
          "docs": [
            "Option token mint (Token-2022 mint)."
          ]
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
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "resalePremium",
          "type": "u64"
        },
        {
          "name": "tokenAmount",
          "type": "u64"
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
      "name": "purchaseOption",
      "docs": [
        "Purchase option tokens. Amount is how many tokens to buy (partial fills supported)."
      ],
      "discriminator": [
        146,
        223,
        0,
        55,
        50,
        0,
        11,
        32
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
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
          "name": "market"
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "purchaseEscrow",
          "docs": [
            "Purchase escrow holding option tokens (Token-2022 account)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "buyerUsdcAccount",
          "writable": true
        },
        {
          "name": "writerUsdcAccount",
          "writable": true
        },
        {
          "name": "buyerOptionAccount",
          "docs": [
            "Buyer's option token account (Token-2022). Frontend creates ATA before calling."
          ],
          "writable": true
        },
        {
          "name": "optionMint",
          "docs": [
            "Option token mint (Token-2022 mint)."
          ]
        },
        {
          "name": "treasury",
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
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
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
      "name": "settleMarket",
      "docs": [
        "Settle an expired market with a price (admin-only for hackathon)."
      ],
      "discriminator": [
        193,
        153,
        95,
        216,
        166,
        6,
        144,
        217
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Only the protocol admin can settle markets (hackathon constraint).",
            "In production, this would be permissionless with Pyth validation."
          ],
          "signer": true
        },
        {
          "name": "protocolState",
          "docs": [
            "Protocol state — used to verify admin identity."
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
            "The market to settle. Must be a valid OptionsMarket account."
          ],
          "writable": true
        }
      ],
      "args": [
        {
          "name": "settlementPrice",
          "type": "u64"
        }
      ]
    },
    {
      "name": "settleVault",
      "docs": [
        "Settle a shared vault after market settlement."
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
            "Anyone can settle a vault (permissionless crank)."
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
            "The market — must be settled (settlement_price set)."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "updatePricing",
      "docs": [
        "Compute Black-Scholes on-chain and store fair value + Greeks.",
        "Permissionless — anyone can call with a spot price and implied vol."
      ],
      "discriminator": [
        157,
        225,
        208,
        150,
        23,
        153,
        253,
        18
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone can call update_pricing (permissionless)."
          ],
          "signer": true
        },
        {
          "name": "pricingData",
          "docs": [
            "The pricing PDA to update. Validated via seeds against the position."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  99,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "optionPosition"
              }
            ]
          }
        },
        {
          "name": "optionPosition",
          "docs": [
            "The option position being priced."
          ]
        },
        {
          "name": "market",
          "docs": [
            "The market — provides strike, expiry, option_type for BS calculation."
          ]
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Optional Pyth PriceUpdateV2 account. If provided, spot price is read",
            "from the oracle with a 30-second staleness check. If not provided,",
            "the spot_price_used parameter is used instead (testing/fallback).",
            "",
            "Anchor's Account<PriceUpdateV2> validates ownership by the Pyth program,",
            "preventing spoofed price accounts."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "spotPriceUsed",
          "type": "u64"
        },
        {
          "name": "impliedVolBps",
          "type": "u64"
        }
      ]
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
    },
    {
      "name": "writeOption",
      "docs": [
        "Write an option: lock collateral, mint option tokens to writer."
      ],
      "discriminator": [
        96,
        144,
        104,
        51,
        39,
        132,
        235,
        38
      ],
      "accounts": [
        {
          "name": "writer",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolState",
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
          "name": "market"
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                "path": "market"
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
          "name": "escrow",
          "docs": [
            "USDC escrow for collateral. Authority = protocol PDA.",
            "This stays on the standard SPL Token program (USDC is not Token-2022)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                "path": "market"
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
          "name": "optionMint",
          "docs": [
            "Option token mint — Token-2022 with TransferHook + PermanentDelegate +",
            "MetadataPointer extensions. Created manually via CPI in the handler",
            "because Anchor's `init` doesn't support Token-2022 extensions.",
            "",
            "the address matches the expected PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "purchaseEscrow",
          "docs": [
            "Purchase escrow — holds option tokens for buyers. Token-2022 token",
            "account created manually in the handler (same reason as mint).",
            "",
            "the address matches the expected PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "writerUsdcAccount",
          "docs": [
            "Writer's USDC account (source of collateral)."
          ],
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "transferHookProgram",
          "docs": [
            "The transfer hook program. Validated against the known program ID."
          ]
        },
        {
          "name": "extraAccountMetaList",
          "docs": [
            "ExtraAccountMetaList PDA — created by the hook program during CPI.",
            "Seeds: [\"extra-account-metas\", mint] on the hook program."
          ],
          "writable": true
        },
        {
          "name": "hookState",
          "docs": [
            "HookState PDA — stores expiry + protocol PDA for the transfer hook.",
            "Seeds: [\"hook-state\", mint] on the hook program."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Standard SPL Token program — used for USDC operations only."
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "docs": [
            "Token-2022 program — used for the option mint and token accounts."
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
          "name": "collateralAmount",
          "type": "u64"
        },
        {
          "name": "premium",
          "type": "u64"
        },
        {
          "name": "contractSize",
          "type": "u64"
        },
        {
          "name": "createdAt",
          "type": "i64"
        }
      ]
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
      "name": "optionPosition",
      "discriminator": [
        212,
        247,
        167,
        73,
        56,
        224,
        204,
        102
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
      "name": "pricingData",
      "discriminator": [
        107,
        24,
        220,
        255,
        130,
        238,
        193,
        92
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
      "name": "alreadyInitialized",
      "msg": "Protocol has already been initialized"
    },
    {
      "code": 6001,
      "name": "unauthorized",
      "msg": "Unauthorized: signer is not the protocol admin"
    },
    {
      "code": 6002,
      "name": "expiryInPast",
      "msg": "Expiry timestamp must be in the future"
    },
    {
      "code": 6003,
      "name": "invalidStrikePrice",
      "msg": "Strike price must be greater than zero"
    },
    {
      "code": 6004,
      "name": "invalidPythFeed",
      "msg": "Invalid Pyth price feed address"
    },
    {
      "code": 6005,
      "name": "invalidAssetName",
      "msg": "Asset name must be 1-16 characters"
    },
    {
      "code": 6006,
      "name": "marketNotExpired",
      "msg": "Market has not expired yet"
    },
    {
      "code": 6007,
      "name": "marketAlreadySettled",
      "msg": "Market has already been settled"
    },
    {
      "code": 6008,
      "name": "marketNotSettled",
      "msg": "Market has not been settled yet"
    },
    {
      "code": 6009,
      "name": "marketExpired",
      "msg": "Market has already expired"
    },
    {
      "code": 6010,
      "name": "invalidSettlementPrice",
      "msg": "Settlement price must be greater than zero"
    },
    {
      "code": 6011,
      "name": "positionNotActive",
      "msg": "Position is no longer active"
    },
    {
      "code": 6012,
      "name": "insufficientCollateral",
      "msg": "Insufficient collateral for this option"
    },
    {
      "code": 6013,
      "name": "invalidContractSize",
      "msg": "Contract size must be greater than zero"
    },
    {
      "code": 6014,
      "name": "invalidPremium",
      "msg": "Premium must be greater than zero"
    },
    {
      "code": 6015,
      "name": "notWriter",
      "msg": "Only the writer can perform this action"
    },
    {
      "code": 6016,
      "name": "notTokenHolder",
      "msg": "Only the token holder can perform this action"
    },
    {
      "code": 6017,
      "name": "cannotBuyOwnOption",
      "msg": "Cannot buy your own option"
    },
    {
      "code": 6018,
      "name": "insufficientOptionTokens",
      "msg": "Insufficient option tokens to exercise"
    },
    {
      "code": 6019,
      "name": "tokensAlreadySold",
      "msg": "Writer must hold all tokens to cancel (some were sold)"
    },
    {
      "code": 6020,
      "name": "notListedForResale",
      "msg": "Option is not listed for resale"
    },
    {
      "code": 6021,
      "name": "alreadyListedForResale",
      "msg": "Option is already listed for resale"
    },
    {
      "code": 6022,
      "name": "notResaleSeller",
      "msg": "Only the resale seller can cancel the listing"
    },
    {
      "code": 6023,
      "name": "cannotBuyOwnResale",
      "msg": "Cannot buy your own resale listing"
    },
    {
      "code": 6024,
      "name": "invalidAssetClass",
      "msg": "Asset class must be 0-4 (crypto, commodity, equity, forex, etf)"
    },
    {
      "code": 6025,
      "name": "cannotExpireItmOption",
      "msg": "Cannot expire an in-the-money option — holders must exercise first"
    },
    {
      "code": 6026,
      "name": "premiumTooLow",
      "msg": "Purchase amount too small — premium rounds to zero"
    },
    {
      "code": 6027,
      "name": "writePremiumTooLow",
      "msg": "Premium too low — must be at least 0.1% of collateral"
    },
    {
      "code": 6028,
      "name": "writePremiumTooHigh",
      "msg": "Premium too high — must be at most 50% of collateral"
    },
    {
      "code": 6029,
      "name": "unauthorizedPricingUpdate",
      "msg": "Only the pricing update authority can update fair values"
    },
    {
      "code": 6030,
      "name": "volTooLow",
      "msg": "Volatility too low — must be at least 500 bps (5%)"
    },
    {
      "code": 6031,
      "name": "volTooHigh",
      "msg": "Volatility too high — must be at most 50000 bps (500%)"
    },
    {
      "code": 6032,
      "name": "optionExpired",
      "msg": "Option has already expired — cannot price"
    },
    {
      "code": 6033,
      "name": "pricingCalculationFailed",
      "msg": "solmath pricing calculation failed"
    },
    {
      "code": 6034,
      "name": "oracleStaleOrInvalid",
      "msg": "Pyth oracle price is stale or invalid — must be less than 30 seconds old"
    },
    {
      "code": 6035,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6036,
      "name": "customVaultSingleWriter",
      "msg": "Custom vaults only allow the original creator to deposit"
    },
    {
      "code": 6037,
      "name": "vaultAlreadySettled",
      "msg": "Vault has been settled, no more deposits allowed"
    },
    {
      "code": 6038,
      "name": "vaultExpired",
      "msg": "Vault expiry has passed"
    },
    {
      "code": 6039,
      "name": "invalidEpochExpiry",
      "msg": "Invalid epoch expiry - must fall on configured day and hour"
    },
    {
      "code": 6040,
      "name": "insufficientVaultCollateral",
      "msg": "Insufficient free collateral in writer's vault position"
    },
    {
      "code": 6041,
      "name": "collateralCommitted",
      "msg": "Collateral is committed to active options and cannot be withdrawn"
    },
    {
      "code": 6042,
      "name": "noTokensToBurn",
      "msg": "No unsold tokens to burn"
    },
    {
      "code": 6043,
      "name": "nothingToClaim",
      "msg": "Nothing to claim - all premium already withdrawn"
    },
    {
      "code": 6044,
      "name": "slippageExceeded",
      "msg": "Premium exceeds buyer's maximum (slippage protection)"
    },
    {
      "code": 6045,
      "name": "vaultNotSettled",
      "msg": "Vault not yet settled"
    },
    {
      "code": 6046,
      "name": "optionNotInTheMoney",
      "msg": "Option is not in the money - cannot exercise"
    },
    {
      "code": 6047,
      "name": "invalidVaultMint",
      "msg": "Option mint does not belong to this vault"
    },
    {
      "code": 6048,
      "name": "expiryMismatch",
      "msg": "Vault expiry must match market expiry"
    },
    {
      "code": 6049,
      "name": "invalidOptionType",
      "msg": "Vault option type must match market option type"
    },
    {
      "code": 6050,
      "name": "claimPremiumFirst",
      "msg": "Claim all premium before withdrawing shares"
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
      "name": "optionPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "docs": [
              "The OptionsMarket this position belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "writer",
            "docs": [
              "The writer (seller) who locked collateral to create this position."
            ],
            "type": "pubkey"
          },
          {
            "name": "optionMint",
            "docs": [
              "The SPL token mint representing ownership of this option."
            ],
            "type": "pubkey"
          },
          {
            "name": "totalSupply",
            "docs": [
              "Total supply of option tokens minted."
            ],
            "type": "u64"
          },
          {
            "name": "tokensSold",
            "docs": [
              "Number of tokens that have been purchased from the primary sale.",
              "Position stays active for more purchases until tokens_sold == total_supply."
            ],
            "type": "u64"
          },
          {
            "name": "collateralAmount",
            "docs": [
              "Amount of USDC collateral locked by the writer, scaled by 10^6."
            ],
            "type": "u64"
          },
          {
            "name": "premium",
            "docs": [
              "Total premium price for ALL tokens (scaled by 10^6 USDC).",
              "Per-token premium = premium / total_supply."
            ],
            "type": "u64"
          },
          {
            "name": "contractSize",
            "docs": [
              "Number of option contracts, scaled by 10^6."
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp when this position was created (also PDA seed)."
            ],
            "type": "i64"
          },
          {
            "name": "isExercised",
            "docs": [
              "Whether ALL tokens have been exercised (escrow fully drained)."
            ],
            "type": "bool"
          },
          {
            "name": "isExpired",
            "docs": [
              "Whether the option has expired without being exercised."
            ],
            "type": "bool"
          },
          {
            "name": "isCancelled",
            "docs": [
              "Whether the writer cancelled this position."
            ],
            "type": "bool"
          },
          {
            "name": "isListedForResale",
            "docs": [
              "Whether this option has tokens listed for resale."
            ],
            "type": "bool"
          },
          {
            "name": "resalePremium",
            "docs": [
              "The resale asking price for ALL listed tokens (scaled by 10^6 USDC).",
              "Per-token resale price = resale_premium / resale_token_amount."
            ],
            "type": "u64"
          },
          {
            "name": "resaleTokenAmount",
            "docs": [
              "How many tokens are currently listed for resale."
            ],
            "type": "u64"
          },
          {
            "name": "resaleSeller",
            "docs": [
              "The seller who listed this for resale."
            ],
            "type": "pubkey"
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
        "Whether this option is a call (right to buy) or put (right to sell)."
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
              "Human-readable asset identifier (e.g. \"SOL\", \"BTC\", \"AAPL\", \"EUR/USD\").",
              "This is a flexible string — the protocol supports ANY asset that has",
              "a Pyth oracle feed. Max 16 characters."
            ],
            "type": "string"
          },
          {
            "name": "strikePrice",
            "docs": [
              "The strike price in USDC, scaled by 10^6.",
              "Example: $200.00 is stored as 200_000_000."
            ],
            "type": "u64"
          },
          {
            "name": "expiryTimestamp",
            "docs": [
              "Unix timestamp when this option expires. After this time, the option",
              "can be settled using the Pyth oracle price."
            ],
            "type": "i64"
          },
          {
            "name": "optionType",
            "docs": [
              "Call or Put."
            ],
            "type": {
              "defined": {
                "name": "optionType"
              }
            }
          },
          {
            "name": "isSettled",
            "docs": [
              "Whether this market has been settled (the Pyth price at expiry has",
              "been recorded). Once settled, no new positions can be written."
            ],
            "type": "bool"
          },
          {
            "name": "settlementPrice",
            "docs": [
              "The Pyth oracle price recorded at settlement time, scaled by 10^6.",
              "Zero until the market is settled."
            ],
            "type": "u64"
          },
          {
            "name": "pythFeed",
            "docs": [
              "The Pyth Network price feed account for this asset.",
              "Used during settlement to read the current price."
            ],
            "type": "pubkey"
          },
          {
            "name": "assetClass",
            "docs": [
              "Asset class for categorizing the underlying asset.",
              "0 = crypto, 1 = commodity, 2 = equity, 3 = forex, 4 = ETF."
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
      "name": "pricingData",
      "docs": [
        "On-chain pricing data for an option position.",
        "Computed on-chain via solmath's bs_full_hp() Black-Scholes engine.",
        "",
        "WHY THIS EXISTS:",
        "Without this, anyone holding an Opta option token has to call our",
        "SDK to know what it's worth. With this, the fair value is right there",
        "on the blockchain — computed deterministically by the smart contract."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "docs": [
              "The option position this pricing data belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "fairValuePerToken",
            "docs": [
              "Last computed fair value per token, in USDC smallest units (6 decimals).",
              "Example: 11_160_000 = $11.16 per token."
            ],
            "type": "u64"
          },
          {
            "name": "spotPriceUsed",
            "docs": [
              "The spot price used in the calculation, in USDC smallest units.",
              "Example: 180_000_000 = $180.00."
            ],
            "type": "u64"
          },
          {
            "name": "impliedVolBps",
            "docs": [
              "The implied volatility used (basis points, e.g. 8500 = 85.00%)."
            ],
            "type": "u64"
          },
          {
            "name": "deltaBps",
            "docs": [
              "Delta (basis points, e.g. 5000 = 0.50 delta).",
              "Positive for calls, negative for puts."
            ],
            "type": "i64"
          },
          {
            "name": "gammaBps",
            "docs": [
              "Gamma (basis points × 100 for precision)."
            ],
            "type": "i64"
          },
          {
            "name": "vegaUsdc",
            "docs": [
              "Vega in micro-USDC (1 unit = 0.000001 USDC) per unit vol move.",
              "Stored at higher precision to avoid truncation to zero for small options."
            ],
            "type": "i64"
          },
          {
            "name": "thetaUsdc",
            "docs": [
              "Theta: daily time decay in micro-USDC (1 unit = 0.000001 USDC).",
              "Typically negative. Stored at higher precision to avoid truncation."
            ],
            "type": "i64"
          },
          {
            "name": "lastUpdated",
            "docs": [
              "Unix timestamp of when this pricing was last updated."
            ],
            "type": "i64"
          },
          {
            "name": "lastUpdater",
            "docs": [
              "The last account that called update_pricing on this PDA.",
              "update_pricing is intentionally permissionless — consumers should",
              "check last_updater to decide whether they trust the data source."
            ],
            "type": "pubkey"
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
