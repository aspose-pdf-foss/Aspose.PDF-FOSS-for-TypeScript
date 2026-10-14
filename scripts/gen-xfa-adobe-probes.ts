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
/** A probe may state its own <pageSet> (164g.9); otherwise the one-page-area default. */
const own = /<pageSet\b[\s\S]*?<\/pageSet>/.exec(body);
const pageSet = own?.[0] ?? `<pageSet><pageArea name="P1" id="P1"><medium short="8.5in" long="11in" stock="letter"/>
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/></pageArea></pageSet>`;
const content = own ? body.replace(own[0], '') : body;

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
    msg = "pages=" + xfa.layout.pageCount() + "\\nareas=" + areas.join(" ") + "\\n" + rows.join("\\n");
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
  <subform name="oracle" layout="tb" w="7.5in"><field name="out" w="7.5in" h="3in"><font typeface="Courier New" size="8pt"/><ui><textEdit multiLine="1"/></ui></field></subform>
  ${content}
</subform></template>`;

const out = new URL(`${name}.out.pdf`, dir);
writeFileSync(out, buildXfaPdf({
  template, needsRendering: true, singleStream: true, extra: { config: CONFIG },
  datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>',
}));
console.log('wrote', out.pathname);
