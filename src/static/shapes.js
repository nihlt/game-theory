/* shapes.js — shared key-shape definitions used by both engine and editor.
 * Single source of truth so the two never drift. */
"use strict";

const SHAPES = [
  [[1,1,1],[0,1,0],[0,1,0]], // T
  [[1,0,0],[1,0,0],[1,1,1]], // L
  [[1,1,0],[0,1,0],[0,1,1]], // S
  [[0,1,0],[1,1,1],[0,1,0]], // +
];
const N_SHAPES = SHAPES.length, N_COLORS = 4, N_ROTS = 4;

function rot3(m){
  const r=[[0,0,0],[0,0,0],[0,0,0]];
  for(let y=0;y<3;y++)for(let x=0;x<3;x++) r[x][2-y]=m[y][x];
  return r;
}
function shapeMask(s,r){ let m=SHAPES[s]; for(let i=0;i<r;i++) m=rot3(m); return m; }

const COLOR_CSS = i => getComputedStyle(document.documentElement).getPropertyValue(`--c${i}`).trim();

/* draw a key silhouette into a 2d context */
function drawKeyShape(ctx,x,y,size,s,c,r){
  const m=shapeMask(s,r), u=size/3;
  ctx.fillStyle=COLOR_CSS(c);
  for(let yy=0;yy<3;yy++)for(let xx=0;xx<3;xx++) if(m[yy][xx]) ctx.fillRect(x+xx*u, y+yy*u, u-1, u-1);
}
