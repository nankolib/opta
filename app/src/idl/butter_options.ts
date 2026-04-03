/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/butter_options.json`.
 */
export type ButterOptions = {
  "address": "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq",
  "metadata": {
    "name": "butterOptions",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "buyResale",
      "docs": [
        "Buy tokens from a resale listing. amount is how many to buy (partial fills)."
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
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
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
    }
  ]
};
