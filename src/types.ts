// Core data model for AIKEA designs.
//
// World coordinates (millimetres):
//   X: left -> right (width)
//   Y: back -> front (depth), Y = 0 is the back of the piece
//   Z: floor -> up (height)
//
// Every part is a rectangular panel with its own right-handed local frame:
//   x: along the panel's length (grain direction), 0..length
//   y: across the panel, 0..width
//   z: through the thickness, 0 at face B, `thickness` at face A
// Face A's outward normal is x̂ × ŷ, i.e. face A is "up" when the part lies on
// a CNC bed with the DXF drawn in its natural orientation. All machining
// coordinates in DXF files are in this local frame.

export type Vec3 = [number, number, number];
export type Axis = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
export type Face = "A" | "B";
export type Edge = "W0" | "W1" | "L0" | "L1"; // W0: x=0 end, W1: x=length end, L0: y=0 long edge, L1: y=width long edge

export interface FaceHole {
  x: number;
  y: number;
  dia: number;
  depth: number; // >= thickness means through
  face: Face;
  purpose: string;
}

export interface EdgeBore {
  edge: Edge;
  along: number; // position along the edge in local coords (y for W edges, x for L edges)
  dia: number;
  depth: number;
  purpose: string;
}

export interface Groove {
  face: Face;
  // groove centre line runs from (x0,y0) to (x1,y1) — axis aligned
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  depth: number;
  purpose: string;
}

export interface Part {
  id: string; // unique instance id, e.g. "side_left"
  name: string; // human name, e.g. "Side panel"
  label?: string; // IKEA-style letter shared by identical parts, assigned later
  material: string; // material key
  length: number;
  width: number;
  thickness: number;
  grain: boolean; // true = length must follow sheet grain
  // placement
  origin: Vec3; // world position of local (0,0,0)
  xAxis: Axis;
  yAxis: Axis;
  edgeBand: Record<Edge, boolean>;
  holes: FaceHole[];
  edgeBores: EdgeBore[];
  grooves: Groove[];
  notes: string[];
}

export type HardwareKey =
  | "cam15"
  | "cam_bolt"
  | "dowel8x30"
  | "confirmat7x50"
  | "shelf_pin5"
  | "anti_tip_kit"
  | "felt_pad"
  | "wood_glue";

export interface HardwareUse {
  key: HardwareKey;
  qty: number;
}

export interface AssemblyStep {
  title: string;
  text: string;
  parts: string[]; // part ids added in this step
  hardware: HardwareUse[];
  hint?: "lay_flat" | "two_people" | "tighten_cams" | "wall_anchor";
}

export interface Issue {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

export interface Design {
  id: string;
  name: string;
  template: string;
  params: Record<string, unknown>;
  createdAt: string;
  overall: { width: number; depth: number; height: number };
  parts: Part[];
  steps: AssemblyStep[];
  issues: Issue[];
  joinery: Joinery;
}

export type Joinery = "cam_dowel" | "confirmat";

export interface MaterialSpec {
  key: string;
  name: string;
  thickness: number;
  sheet: { length: number; width: number }; // length follows grain
  grain: boolean;
  modulusMPa: number; // bending modulus for sag estimates
  densityKgM3: number;
  pilotDia: number; // confirmat pilot diameter suited to the core
  notes: string;
}
