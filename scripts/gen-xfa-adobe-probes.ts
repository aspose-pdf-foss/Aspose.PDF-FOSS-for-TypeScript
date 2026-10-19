// scripts/gen-xfa-adobe-probes.ts -- NOT run by npm test.
// Builds an XFA probe for Adobe Reader (164g.11): a dynamic form whose docReady
// script writes Adobe's xfa.layout of every subform, field and draw into a
// visible field at the top of page 1. Usage:
//   npx tsx scripts/gen-xfa-adobe-probes.ts t5
// then scripts/run-xfa-adobe-probe.ps1 -Name t5.out to open it in Reader and
// capture the window. The vendored tN.pdf are the bytes Reader rendered; this
// script rebuilds them without the spike's save call, so only the script text
// differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildXfaPdf } from '../test/helpers/build-xfa-pdf.js';

const name = process.argv[2];
if (!name) throw new Error('usage: gen-xfa-adobe-probes.ts <probe name, e.g. t5>');
const dir = new URL('../test/fixtures/xfa-adobe/', import.meta.url);
const body = readFileSync(new URL(`${name}.xml`, dir), 'utf8');
/** A probe may state its own <pageSet> (164g.9); otherwise the one-page-area default.
 *  Greedy since 164g.22, so nested and sibling page sets are taken whole. */
const own = /<pageSet\b[\s\S]*<\/pageSet>/.exec(body);
const pageSet = own?.[0] ?? `<pageSet><pageArea name="P1" id="P1"><medium short="8.5in" long="11in" stock="letter"/>
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/></pageArea></pageSet>`;
/** A probe may state a <proto> (164g.15): leaders and trailers by #id. It goes
 *  beside the root subform, as XFA 3.3's examples place it. */
const proto = body.includes('<!-- proto in root -->') ? null : /<proto\b[\s\S]*?<\/proto>/.exec(body);
/** A probe may shrink the oracle field (164g.20): `<!-- oracle 1in -->` makes room
 *  on a small page for a probe read from the capture rather than the report. */
const oracleH = /<!-- oracle (\S+) -->/.exec(body)?.[1] ?? '3in';
const content = [own?.[0], proto?.[0]].reduce((s, x) => (x ? s.replace(x, '') : s), body);

/** Walk xfa.form and write each node's fragments -- page, then x, y, w, h in
 *  points relative to its parent's content box -- into form1.oracle.out. */
const script = `
if (typeof probeDone == "undefined") {
  probeDone = true;
  var rows = [];
  function walk(n) {
    for (var i = 0; i < n.nodes.length; i++) {
      var c = n.nodes.item(i);
      if (c.className == "field" || c.className == "subform" || c.className == "draw") {
        var span = xfa.layout.pageSpan(c);
        var frags = [];
        for (var k = 0; k < span; k++)
          frags.push([xfa.layout.page(c) + k, xfa.layout.x(c, "pt", k), xfa.layout.y(c, "pt", k), xfa.layout.w(c, "pt", k), xfa.layout.h(c, "pt", k)].join(","));
        rows.push(c.somExpression + "=" + frags.join(";"));
        walk(c);
      }
    }
  }
  var msg = "";
  try {
    walk(xfa.form);
    var areas = [];
    for (var p = 0; p < xfa.layout.pageCount(); p++) {
      var ds = xfa.layout.pageContent(p, "draw", true);
      var nm = [];
      for (var j = 0; j < ds.length; j++) nm.push(ds.item(j).name);
      areas.push((p + 1) + ":" + nm.join("/"));
    }
    // 164g.15: what the Layout DOM holds per page, leader and trailer
    // instances included -- they need not be nodes xfa.form's walk reaches.
    var content = [];
    for (var p2 = 0; p2 < xfa.layout.pageCount(); p2++) {
      var cs = xfa.layout.pageContent(p2, "subform", false);
      var cn = [];
      for (var j2 = 0; j2 < cs.length; j2++) cn.push(cs.item(j2).name);
      content.push((p2 + 1) + ":" + cn.join("/"));
    }
    // 164g.15: SOM names without "xfa[0].form[0].form1[0]." and "[0]", packed
    // two to a line, so a probe's report fits the field's visible lines.
    var packed = [], line = "";
    for (var r = 0; r < rows.length; r++) {
      var s = rows[r].replace("xfa[0].form[0].form1[0].", "").split("[0]").join("");
      if (line != "" && line.length + s.length > 100) { packed.push(line); line = ""; }
      line = line == "" ? s : line + "  " + s;
    }
    if (line != "") packed.push(line);
    msg = "pages=" + xfa.layout.pageCount() + "\\nareas=" + areas.join(" ") + "\\ncontent=" + content.join(" ") + "\\n" + packed.join("\\n");
  }
  catch (e) { msg = "ERR " + e; }
  xfa.form.form1.oracle.out.rawValue = msg;
}`;

// acrobat7/dynamicRender=required is what makes Reader lay the form out
// dynamically; without the config packet it draws a blank static page.
const CONFIG = `<config xmlns="http://www.xfa.org/schema/xci/2.8/"><agent name="designer"><destination>pdf</destination></agent><present><pdf><version>1.7</version><scriptModel>XFA</scriptModel><interactive>1</interactive></pdf><common><data><adjustData>1</adjustData></data></common><script><runScripts>both</runScripts></script></present><acrobat><acrobat7><dynamicRender>required</dynamicRender></acrobat7><common><validate>preSubmit</validate></common></acrobat></config>`;
const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/2.8/"><subform name="form1" layout="tb" locale="en_US">
  ${pageSet}
  <event activity="docReady" ref="$host"><script contentType="application/x-javascript">${script.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</script></event>
  <subform name="oracle" layout="tb" w="7.5in"><field name="out" w="7.5in" h="${oracleH}"><font typeface="Courier New" size="8pt"/><ui><textEdit multiLine="1"/></ui></field></subform>
  ${content}
</subform>${proto?.[0] ?? ''}</template>`;

const out = new URL(`${name}.out.pdf`, dir);
writeFileSync(out, buildXfaPdf({
  template, needsRendering: true, singleStream: true, extra: { config: CONFIG },
  datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>',
}));
console.log('wrote', out.pathname);
