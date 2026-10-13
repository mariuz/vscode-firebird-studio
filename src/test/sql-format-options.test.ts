import * as assert from "assert";
import { formatSQL } from "../shared/sql-formatter";
import {
  indentFromEditor, resolveKeywordCase, resolveCommaPlacement, resolveClauseIndentation, buildFormatOptions
} from "../language-server/format-model";

/**
 * The formatter took no options at all until it became a real formatting provider. These cover the
 * two knobs that adds -- keyword casing, and an indent that comes from the editor rather than from
 * a second setting of our own -- plus the guarantee that calling it with no options at all still
 * does exactly what it did before, which is what the 19 tests in sql-formatter.test.ts pin.
 */
suite("formatSQL() – options", function () {
  suite("keywordCase", function () {
    test("defaults to upper, unchanged from before options existed", function () {
      assert.strictEqual(formatSQL("select a from t"), formatSQL("select a from t", { keywordCase: "upper" }));
      assert.ok(formatSQL("select a from t").startsWith("SELECT"));
    });

    test("lower cases every recognised keyword down", function () {
      const out = formatSQL("SELECT A FROM T WHERE A = 1", { keywordCase: "lower" });
      assert.ok(out.includes("select"), out);
      assert.ok(out.includes("from"), out);
      assert.ok(out.includes("where"), out);
      assert.ok(!/\bSELECT\b/.test(out), out);
      assert.ok(!/\bWHERE\b/.test(out), out);
    });

    test("lower leaves identifiers alone -- it cases keywords, not everything", function () {
      const out = formatSQL("SELECT CustomerName FROM Customers", { keywordCase: "lower" });
      assert.ok(out.includes("CustomerName"), out);
      assert.ok(out.includes("Customers"), out);
    });

    // The layout pass rewrites SELECT/FROM itself, so preserve has to survive that too -- it was
    // re-emitting both from string literals and quietly uppercasing them.
    test("preserve leaves the author's own casing exactly as typed", function () {
      const out = formatSQL("select a, b from t where a = 1", { keywordCase: "preserve" });
      assert.ok(out.includes("select"), out);
      assert.ok(out.includes("from"), out);
      assert.ok(out.includes("where"), out);
      assert.ok(!/\bSELECT\b/.test(out), `SELECT was uppercased under preserve: ${out}`);
      assert.ok(!/\bFROM\b/.test(out), `FROM was uppercased under preserve: ${out}`);
    });

    test("preserve keeps mixed casing rather than normalising it", function () {
      const out = formatSQL("Select a From t", { keywordCase: "preserve" });
      assert.ok(out.includes("Select"), out);
      assert.ok(out.includes("From"), out);
    });

    test("preserve still applies layout -- it is a casing option, not an off switch", function () {
      const out = formatSQL("select a from t where a = 1", { keywordCase: "preserve" });
      assert.ok(out.split("\n").length >= 3, `layout was not applied: ${JSON.stringify(out)}`);
    });

    test("string literals are untouched whatever the casing option", function () {
      for (const keywordCase of ["upper", "lower", "preserve"] as const) {
        const out = formatSQL("select 'From Select Where' from t", { keywordCase });
        assert.ok(out.includes("'From Select Where'"), `${keywordCase}: ${out}`);
      }
    });
  });

  suite("indent", function () {
    test("defaults to the four spaces this formatter always used", function () {
      const out = formatSQL("select a, b from t");
      assert.ok(out.includes("\n    a,"), JSON.stringify(out));
    });

    test("a two-space indent is honoured", function () {
      const out = formatSQL("select a, b from t", { indent: "  " });
      assert.ok(out.includes("\n  a,"), JSON.stringify(out));
      assert.ok(!out.includes("\n    a,"), JSON.stringify(out));
    });

    test("a tab indent is honoured", function () {
      const out = formatSQL("select a, b from t", { indent: "\t" });
      assert.ok(out.includes("\n\ta,"), JSON.stringify(out));
    });
  });

  suite("commaPlacement", function () {
    test("defaults to trailing, comma at the end of each column line", function () {
      const out = formatSQL("select id, name, email from customers");
      assert.strictEqual(
        out,
        "SELECT\n    id,\n    name,\n    email\nFROM customers"
      );
    });

    test("leading comma places comma at the start of subsequent column lines", function () {
      const out = formatSQL("select id, name, email from customers", { commaPlacement: "leading" });
      assert.strictEqual(
        out,
        "SELECT\n    id\n    , name\n    , email\nFROM customers"
      );
    });

    test("a single column has no comma under either trailing or leading", function () {
      const trailing = formatSQL("select id from customers", { commaPlacement: "trailing" });
      const leading = formatSQL("select id from customers", { commaPlacement: "leading" });
      assert.strictEqual(trailing, "SELECT\n    id\nFROM customers");
      assert.strictEqual(leading, "SELECT\n    id\nFROM customers");
    });

    test("preserves parenthesized functions with internal commas intact", function () {
      const out = formatSQL("select id, coalesce(name, 'N/A'), email from customers", { commaPlacement: "leading" });
      assert.ok(out.includes("    , COALESCE(name, 'N/A')"), out);
      assert.ok(out.includes("    , email"), out);
    });
  });

  suite("clauseIndentation", function () {
    test("defaults to none with clauses aligned to margin", function () {
      const sql = "select a from b left join c on b.id = c.id where a = 1 and b = 2 or c = 3 order by a";
      const out = formatSQL(sql);
      assert.ok(out.includes("\nLEFT\nJOIN c"), out);
      assert.ok(out.includes("\nON b.id = c.id"), out);
      assert.ok(out.includes("\nWHERE a = 1"), out);
      assert.ok(out.includes("\nAND b = 2"), out);
      assert.ok(out.includes("\nOR c = 3"), out);
    });

    test("subclauses indents JOIN, ON, AND, OR under their parent clauses", function () {
      const sql = "select a, b from t1 left join t2 on t1.id = t2.id where a = 1 and b = 2 or c = 3 order by a";
      const out = formatSQL(sql, { clauseIndentation: "subclauses" });
      assert.ok(out.includes("\n    LEFT\n    JOIN t2"), out);
      assert.ok(out.includes("\n        ON t1.id = t2.id"), out);
      assert.ok(out.includes("\nWHERE a = 1"), out);
      assert.ok(out.includes("\n    AND b = 2"), out);
      assert.ok(out.includes("\n    OR c = 3"), out);
      assert.ok(out.includes("\nORDER BY a"), out);
    });

    test("clauseIndentation honors custom indent string", function () {
      const sql = "select a from t where a = 1 and b = 2";
      const out = formatSQL(sql, { indent: "  ", clauseIndentation: "subclauses" });
      assert.ok(out.includes("\n  AND b = 2"), out);
    });
  });

  suite("combined granular options", function () {
    test("leading commas + subclauses + uppercase + 2 spaces indent", function () {
      const sql = "select id, name, email from customers left join orders on customers.id = orders.customer_id where id = 1 and active = 1";
      const out = formatSQL(sql, {
        indent: "  ",
        keywordCase: "upper",
        commaPlacement: "leading",
        clauseIndentation: "subclauses",
      });
      const expected =
        "SELECT\n" +
        "  id\n" +
        "  , name\n" +
        "  , email\n" +
        "FROM customers\n" +
        "  LEFT\n" +
        "  JOIN orders\n" +
        "    ON customers.id = orders.customer_id\n" +
        "WHERE id = 1\n" +
        "  AND active = 1";
      assert.strictEqual(out, expected);
    });
  });
});

suite("Formatting provider – indentFromEditor()", function () {
  test("spaces produce that many spaces", function () {
    assert.strictEqual(indentFromEditor({ tabSize: 2, insertSpaces: true }), "  ");
    assert.strictEqual(indentFromEditor({ tabSize: 8, insertSpaces: true }), "        ");
  });

  test("tabs produce one tab, whatever tabSize claims -- a tab's width is a rendering choice", function () {
    assert.strictEqual(indentFromEditor({ tabSize: 4, insertSpaces: false }), "\t");
    assert.strictEqual(indentFromEditor({ tabSize: 8, insertSpaces: false }), "\t");
  });

  test("a nonsense tab size falls back to four rather than producing no indent at all", function () {
    assert.strictEqual(indentFromEditor({ tabSize: 0, insertSpaces: true }), "    ");
    assert.strictEqual(indentFromEditor({ tabSize: -2, insertSpaces: true }), "    ");
    assert.strictEqual(indentFromEditor({ tabSize: NaN, insertSpaces: true }), "    ");
  });

  test("a fractional tab size is floored, not passed to repeat() to throw", function () {
    assert.strictEqual(indentFromEditor({ tabSize: 2.7, insertSpaces: true }), "  ");
  });
});

suite("Formatting provider – resolveKeywordCase()", function () {
  test("accepts the three documented values", function () {
    assert.strictEqual(resolveKeywordCase("upper"), "upper");
    assert.strictEqual(resolveKeywordCase("lower"), "lower");
    assert.strictEqual(resolveKeywordCase("preserve"), "preserve");
  });

  test("anything else falls back to the manifest default rather than reaching the formatter", function () {
    // A settings value can be anything at all -- it comes from a JSON file the user edits.
    assert.strictEqual(resolveKeywordCase("UPPER"), "upper");
    assert.strictEqual(resolveKeywordCase("shouty"), "upper");
    assert.strictEqual(resolveKeywordCase(undefined), "upper");
    assert.strictEqual(resolveKeywordCase(null), "upper");
    assert.strictEqual(resolveKeywordCase(42), "upper");
  });
});

suite("Formatting provider – resolveCommaPlacement()", function () {
  test("accepts trailing and leading values", function () {
    assert.strictEqual(resolveCommaPlacement("trailing"), "trailing");
    assert.strictEqual(resolveCommaPlacement("leading"), "leading");
  });

  test("falls back to trailing on invalid or missing values", function () {
    assert.strictEqual(resolveCommaPlacement(undefined), "trailing");
    assert.strictEqual(resolveCommaPlacement(null), "trailing");
    assert.strictEqual(resolveCommaPlacement("invalid"), "trailing");
    assert.strictEqual(resolveCommaPlacement(123), "trailing");
  });
});

suite("Formatting provider – resolveClauseIndentation()", function () {
  test("accepts none and subclauses values", function () {
    assert.strictEqual(resolveClauseIndentation("none"), "none");
    assert.strictEqual(resolveClauseIndentation("subclauses"), "subclauses");
  });

  test("accepts boolean true or indented as subclauses", function () {
    assert.strictEqual(resolveClauseIndentation(true), "subclauses");
    assert.strictEqual(resolveClauseIndentation("indented"), "subclauses");
    assert.strictEqual(resolveClauseIndentation(false), "none");
  });

  test("falls back to none on invalid or missing values", function () {
    assert.strictEqual(resolveClauseIndentation(undefined), "none");
    assert.strictEqual(resolveClauseIndentation(null), "none");
    assert.strictEqual(resolveClauseIndentation("bogus"), "none");
  });
});

suite("Formatting provider – buildFormatOptions()", function () {
  test("combines the editor's indentation with the user's settings", function () {
    assert.deepStrictEqual(
      buildFormatOptions({ tabSize: 2, insertSpaces: true }, "lower", "leading", "subclauses"),
      { indent: "  ", keywordCase: "lower", commaPlacement: "leading", clauseIndentation: "subclauses" }
    );
  });

  test("survives garbage settings without losing the editor's indentation", function () {
    assert.deepStrictEqual(
      buildFormatOptions({ tabSize: 4, insertSpaces: false }, {}, {}, {}),
      { indent: "\t", keywordCase: "upper", commaPlacement: "trailing", clauseIndentation: "none" }
    );
  });

  test("what it returns actually drives formatSQL", function () {
    const out = formatSQL(
      "select a, b from t where a = 1 and b = 2",
      buildFormatOptions({ tabSize: 2, insertSpaces: true }, "lower", "leading", "subclauses")
    );
    assert.ok(out.startsWith("select"), out);
    assert.ok(out.includes("\n  a\n  , b"), JSON.stringify(out));
    assert.ok(out.includes("\n  and b = 2"), JSON.stringify(out));
  });
});
