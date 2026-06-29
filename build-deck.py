"""Generate a 5-slide executive deck for Agent Runtime Sidecar."""
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

# Palette
INK = RGBColor(0x10, 0x14, 0x20)
SLATE = RGBColor(0x4A, 0x55, 0x68)
ACCENT = RGBColor(0x2D, 0x6C, 0xDF)
ACCENT2 = RGBColor(0x12, 0xA5, 0x94)
LIGHT = RGBColor(0xF3, 0xF5, 0xFA)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
MUTED = RGBColor(0x7A, 0x86, 0x99)

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
SW, SH = prs.slide_width, prs.slide_height
BLANK = prs.slide_layouts[6]


def add_bg(slide, color):
    r = slide.shapes.add_shape(1, 0, 0, SW, SH)
    r.fill.solid(); r.fill.fore_color.rgb = color
    r.line.fill.background()
    r.shadow.inherit = False
    slide.shapes._spTree.remove(r._element); slide.shapes._spTree.insert(2, r._element)
    return r


def band(slide, x, y, w, h, color):
    r = slide.shapes.add_shape(1, x, y, w, h)
    r.fill.solid(); r.fill.fore_color.rgb = color
    r.line.fill.background(); r.shadow.inherit = False
    return r


def txt(slide, x, y, w, h, runs, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, sp=1.0, space_after=4):
    tb = slide.shapes.add_textbox(x, y, w, h); tf = tb.text_frame
    tf.word_wrap = True; tf.vertical_anchor = anchor
    for i, (text, size, color, bold) in enumerate(runs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align; p.line_spacing = sp; p.space_after = Pt(space_after)
        r = p.add_run(); r.text = text; f = r.font
        f.size = Pt(size); f.color.rgb = color; f.bold = bold; f.name = "Segoe UI"
    return tb


def bullet(slide, x, y, w, h, title, body, tcolor=INK):
    tb = slide.shapes.add_textbox(x, y, w, h); tf = tb.text_frame; tf.word_wrap = True
    p = tf.paragraphs[0]; r = p.add_run(); r.text = title
    r.font.size = Pt(17); r.font.bold = True; r.font.color.rgb = tcolor; r.font.name = "Segoe UI"
    p.space_after = Pt(2)
    p2 = tf.add_paragraph(); r2 = p2.add_run(); r2.text = body
    r2.font.size = Pt(12.5); r2.font.color.rgb = SLATE; r2.font.name = "Segoe UI"; p2.line_spacing = 1.05
    return tb

# ---------------- Slide 1: Positioning ----------------
s = prs.slides.add_slide(BLANK)
add_bg(s, INK)
band(s, 0, Inches(5.45), SW, Inches(0.12), ACCENT)
txt(s, Inches(0.9), Inches(1.0), Inches(11.5), Inches(0.6),
    [("AGENT RUNTIME SIDECAR", 16, ACCENT2, True)])
txt(s, Inches(0.9), Inches(1.7), Inches(11.5), Inches(2.6), [
    ("An AI Session Management", 50, WHITE, True),
    ("Architecture & Service", 50, WHITE, True),
], sp=1.0)
txt(s, Inches(0.9), Inches(4.1), Inches(11.0), Inches(1.0),
    [("Run stateful, interactive agents as durable online services — where the session, not the machine, is the durable identity.", 20, RGBColor(0xC6,0xD0,0xE0), False)])
txt(s, Inches(0.9), Inches(6.2), Inches(11.5), Inches(0.8), [
    ("Infrastructure for teams putting agents in production: durable sessions · recovery · real-time control · multi-tenant auth & audit", 13, MUTED, False)])

# ---------------- Slide 2: Who is the customer ----------------
s = prs.slides.add_slide(BLANK)
add_bg(s, WHITE)
band(s, 0, 0, SW, Inches(1.25), LIGHT)
txt(s, Inches(0.9), Inches(0.3), Inches(11.5), Inches(0.7),
    [("Our customer builds agentic apps — that's why it's B2B", 28, INK, True)])
txt(s, Inches(0.9), Inches(1.45), Inches(11.5), Inches(0.7),
    [("Our user is the developer embedding agents into a product — not the consumer remote-controlling one personal agent. The two pull the runtime in opposite directions.", 14.5, SLATE, False)])
# LEFT: our market
band(s, Inches(0.9), Inches(2.35), Inches(5.6), Inches(4.4), RGBColor(0xE8,0xEE,0xFA))
band(s, Inches(0.9), Inches(2.35), Inches(5.6), Inches(0.12), ACCENT)
txt(s, Inches(1.2), Inches(2.6), Inches(5.0), Inches(0.5), [("B2B · APPS BUILT ON AGENTS  ← us", 13, ACCENT, True)])
bullet(s, Inches(1.2), Inches(3.2), Inches(5.0), Inches(0.9), "Called by code", "App servers and workflows invoke the agent — no human babysitting it.")
bullet(s, Inches(1.2), Inches(4.2), Inches(5.0), Inches(0.9), "Definable environment", "One agent class, homogeneous workers the platform can schedule & recover.")
bullet(s, Inches(1.2), Inches(5.2), Inches(5.0), Inches(1.2), "Needs a service", "Session continuity, controllability, and recovery in every state — pause, disconnect, worker crash.")
# RIGHT: not us
band(s, Inches(6.85), Inches(2.35), Inches(5.6), Inches(4.4), INK)
txt(s, Inches(7.15), Inches(2.6), Inches(5.0), Inches(0.5), [("2C · REMOTE-CONTROL PERSONAL AGENTS  — not us", 13, ACCENT2, True)])
for i,(t,b) in enumerate([
    ("Driven by a person","A user steers one agent live on their own machine."),
    ("Undefinable environment","Personal, variable, can't be standardized or scheduled."),
    ("Needs a wire","Just connect and watch — no shared runtime to operate."),
]):
    txt(s, Inches(7.15), Inches(3.2)+Inches(1.0)*i, Inches(5.0), Inches(0.95), [(t,16,WHITE,True),(b,12.5,RGBColor(0xB6,0xC0,0xD0),False)])

# ---------------- Slide 3: What they need (design taste) ----------------
s = prs.slides.add_slide(BLANK)
add_bg(s, WHITE)
band(s, 0, 0, SW, Inches(1.25), LIGHT)
txt(s, Inches(0.9), Inches(0.3), Inches(11.5), Inches(0.7), [("So B2B asks for three things — and we have an opinion on each", 26, INK, True)])
txt(s, Inches(0.9), Inches(1.45), Inches(11.5), Inches(0.6), [("The same three pillars from the B2B column, made concrete. This is the design taste — what a code-driven, durable agent service must guarantee.", 14.5, SLATE, False)])
pillars = [
    ("01", "Continuity", "The session is the identity", [
        "Lives independently of any worker — id, owner, status, history",
        "Bring your existing agent via a sidecar, no rewrite",
    ], ACCENT),
    ("02", "Controllability", "Code stays in command", [
        "Create, stream, approve, cancel, steer — all through an API",
        "Multi-tenant auth & audit on every path",
    ], ACCENT2),
    ("03", "Recoverability", "Survive any state", [
        "Snapshot workspace + event log, not just transcript",
        "Resume on fresh compute after pause / disconnect / crash",
    ], ACCENT),
]
cw, gx = Inches(3.7), Inches(0.25); x0, y0 = Inches(0.9), Inches(2.35); ch = Inches(4.4)
for i,(num,t,sub,items,col) in enumerate(pillars):
    cx = x0 + (cw+gx)*i
    band(s, cx, y0, cw, ch, LIGHT)
    band(s, cx, y0, cw, Inches(0.12), col)
    txt(s, cx+Inches(0.3), y0+Inches(0.3), cw-Inches(0.6), Inches(0.6), [(num, 28, col, True)])
    txt(s, cx+Inches(0.3), y0+Inches(0.95), cw-Inches(0.6), Inches(0.6), [(t, 20, INK, True)])
    txt(s, cx+Inches(0.3), y0+Inches(1.5), cw-Inches(0.6), Inches(0.5), [(sub, 13, MUTED, True)])
    for j,it in enumerate(items):
        txt(s, cx+Inches(0.3), y0+Inches(2.1)+Inches(1.0)*j, cw-Inches(0.6), Inches(1.0), [("— "+it, 13, SLATE, False)], sp=1.05)

# ---------------- Slide 4: What the framework actually is ----------------
s = prs.slides.add_slide(BLANK)
add_bg(s, WHITE)
band(s, 0, 0, SW, Inches(1.25), LIGHT)
txt(s, Inches(0.9), Inches(0.32), Inches(11.5), Inches(0.7), [("What the framework actually is", 30, INK, True)])
txt(s, Inches(0.9), Inches(1.45), Inches(11.5), Inches(0.6), [("A central session control plane + a sidecar per worker. Four components map 1:1 to what customers need.", 15, SLATE, False)])
rows = [
    ("Central Session Service", "Session catalog · routing · connections · auth · audit"),
    ("Agent Runtime Sidecar", "Wraps the existing agent process; forwards events; snapshots"),
    ("Persistent Storage", "Sessions, event log, workspace snapshots, artifacts, audit"),
    ("SDKs & APIs", "Stable surface for apps, clients, and workers"),
]
y = Inches(2.4)
for i,(t,b) in enumerate(rows):
    band(s, Inches(0.9), y, Inches(7.2), Inches(0.95), LIGHT if i%2 else RGBColor(0xE8,0xEE,0xFA))
    txt(s, Inches(1.15), y+Inches(0.12), Inches(3.0), Inches(0.7), [(t,15,INK,True)], anchor=MSO_ANCHOR.MIDDLE)
    txt(s, Inches(4.0), y+Inches(0.12), Inches(4.0), Inches(0.7), [(b,11.5,SLATE,False)], anchor=MSO_ANCHOR.MIDDLE)
    y += Inches(1.07)
band(s, Inches(8.5), Inches(2.4), Inches(3.95), Inches(4.3), INK)
txt(s, Inches(8.8), Inches(2.65), Inches(3.4), Inches(0.5), [("PROVEN IN THE POC", 12, ACCENT2, True)])
txt(s, Inches(8.8), Inches(3.2), Inches(3.4), Inches(3.2), [
    ("Chat with an agent", 15, WHITE, True),
    ("Pause — its worker is recycled", 13, RGBColor(0xC6,0xD0,0xE0), False),
    ("Resume — a brand-new worker", 15, WHITE, True),
    ("restores workspace + memory; the conversation continues.", 13, RGBColor(0xC6,0xD0,0xE0), False),
], sp=1.05, space_after=10)

# ---------------- Slide 5: Why it matters ----------------
s = prs.slides.add_slide(BLANK)
add_bg(s, INK)
band(s, 0, Inches(1.4), SW, Inches(0.1), ACCENT)
txt(s, Inches(0.9), Inches(0.55), Inches(11.5), Inches(0.8), [("Why this is worth building", 34, WHITE, True)])
points = [
    ("Every team rebuilds this", "Session router, worker registry, event log, snapshots, auth — built once, badly, in every project."),
    ("We sell the missing runtime", "Not models, not a framework — the durable session layer between them."),
    ("Differentiated & defensible", "Operational runtime, not agent intelligence; sidecar adopts existing agents."),
    ("Land via self-host, expand to managed", "Same model from local POC to cluster to cloud service."),
]
y = Inches(1.9)
for t,b in points:
    band(s, Inches(0.9), y+Inches(0.1), Inches(0.12), Inches(0.9), ACCENT2)
    txt(s, Inches(1.2), y, Inches(11.0), Inches(1.0), [(t,19,WHITE,True),(b,13.5,RGBColor(0xC6,0xD0,0xE0),False)], space_after=2)
    y += Inches(1.18)

import os, time
out = r"c:\Users\chenyl\newconduit\Agent-Runtime-Sidecar.pptx"
try:
    prs.save(out)
except PermissionError:
    out = rf"c:\Users\chenyl\newconduit\Agent-Runtime-Sidecar-v{int(time.time())}.pptx"
    prs.save(out)
print("saved", out)
