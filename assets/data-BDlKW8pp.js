import{a as Z}from"./main-XTDTNN0j.js";import{Y as _,Z as J,$ as G,d as W,W as Q,a0 as tt,a1 as H,a2 as et,a3 as at}from"./lineSet-BFHb7qOO.js";const st={inject:{"vs:#decl":`
in vec2 instanceDashArrays;
#ifdef HIGH_PRECISION_DASH
in vec2 instanceDashOffsets;
#endif
out vec2 vDashArray;
out float vDashOffset;
out float vDashPathLength;
layout(std140) uniform pathStyleUniforms {
float dashAlignMode;
bool dashGapPickable;
highp int dashUnits;
} pathStyle;
`,"vs:#main-end":`
float dashWidthPixels = path.billboard
? width.x * project.focalDistance
: width.x * project.scale;
float strokeHalfWidthPixels = path.billboard ? width.x : width.x * project.scale;
float dashUnitPixels = strokeHalfWidthPixels;
if (pathStyle.dashUnits == 1) {
dashUnitPixels = 1.0;
} else if (pathStyle.dashUnits == 2) {
dashUnitPixels = project_size_to_pixel(1.0);
} else if (pathStyle.dashUnits == 3) {
dashUnitPixels = project.scale;
}
vDashArray = instanceDashArrays * (dashUnitPixels / dashWidthPixels);
#ifdef HIGH_PRECISION_DASH
vec2 dashOffsetAndLength = (instanceDashOffsets * project.scale) / dashWidthPixels;
vDashPathLength = dashOffsetAndLength.y;
float dashUnitLength = vDashArray.x + vDashArray.y;
float dashPeriod = pathStyle.dashAlignMode == 0.0
? dashUnitLength
: vDashPathLength / max(round(vDashPathLength / max(dashUnitLength, 0.0001)), 1.0);
vDashOffset = dashPeriod > 0.0 ? mod(dashOffsetAndLength.x, dashPeriod) : 0.0;
#else
vDashOffset = 0.0;
vDashPathLength = 0.0;
#endif
`,"fs:#decl":`
layout(std140) uniform pathStyleUniforms {
float dashAlignMode;
bool dashGapPickable;
highp int dashUnits;
} pathStyle;
in vec2 vDashArray;
in float vDashOffset;
in float vDashPathLength;
float dashPatternIntegral(float position, float solidLength, float unitLength) {
return floor(position / unitLength) * solidLength +
min(mod(position, unitLength), solidLength);
}
float dashPatternCoverage(
float position,
float solidLength,
float unitLength,
float filterWidth
) {
float halfFilter = 0.5 * filterWidth;
float reducedPosition = mod(position, unitLength);
return (dashPatternIntegral(reducedPosition + halfFilter, solidLength, unitLength) -
dashPatternIntegral(reducedPosition - halfFilter, solidLength, unitLength)) / filterWidth;
}
`,"fs:#main-start":`
float dashCoverage = 1.0;
bool shouldDiscardDash = false;
bool inRoundedDashGap = false;
float roundedDashResolvedCoverage = 1.0;
float roundedDashSubPixelBlend = 0.0;
float roundedDashDutyCycle = 1.0;
float solidLength = vDashArray.x;
float gapLength = vDashArray.y;
float unitLength = solidLength + gapLength;
if (unitLength > 0.0 && gapLength > 0.0) {
float offset;
if (pathStyle.dashAlignMode == 0.0) {
offset = vDashOffset;
} else {
#ifdef HIGH_PRECISION_DASH
unitLength = vDashPathLength / max(round(vDashPathLength / unitLength), 1.0);
#else
unitLength = vPathLength / max(round(vPathLength / unitLength), 1.0);
#endif
solidLength = min(solidLength, unitLength);
offset = solidLength / 2.0;
#ifdef HIGH_PRECISION_DASH
offset += vDashOffset;
#endif
}
float alongPath = vPathPosition.y + offset;
float unitOffset = mod(alongPath, unitLength);
float filterWidth = max(fwidth(alongPath), 0.0001);
if (bool(picking.isActive)) {
bool inGap = unitOffset > solidLength;
if (inGap && path.capType > 0.5) {
inGap = length(vec2(
min(unitOffset - solidLength, unitLength - unitOffset),
vPathPosition.x
)) > 1.0;
}
if (inGap && !pathStyle.dashGapPickable) {
shouldDiscardDash = true;
}
} else if (path.capType <= 0.5) {
dashCoverage = dashPatternCoverage(alongPath, solidLength, unitLength, filterWidth);
} else {
float distanceAlongGap = min(unitOffset - solidLength, unitLength - unitOffset);
float distanceToEnd = length(vec2(max(distanceAlongGap, 0.0), vPathPosition.x));
float capEdgePixels = (1.0 - distanceToEnd) / max(fwidth(distanceToEnd), 1e-6);
if (distanceAlongGap > 0.0) {
inRoundedDashGap = true;
roundedDashResolvedCoverage = smoothedge(0.0, capEdgePixels);
dashCoverage = roundedDashResolvedCoverage;
}
float subPixelBlend = smoothstep(unitLength, 2.0 * unitLength, filterWidth);
roundedDashSubPixelBlend = subPixelBlend;
float boundedSolidLength = min(solidLength, unitLength);
float effectiveGap = max(unitLength - boundedSolidLength, 0.0);
float capSpan = 2.0 * sqrt(max(1.0 - vPathPosition.x * vPathPosition.x, 0.0));
float roundedDutyCycle = clamp(
(boundedSolidLength + min(effectiveGap, capSpan)) / unitLength,
0.0,
1.0
);
roundedDashDutyCycle = roundedDutyCycle;
dashCoverage = mix(dashCoverage, roundedDutyCycle, subPixelBlend);
}
dashCoverage = clamp(dashCoverage, 0.0, 1.0);
shouldDiscardDash = shouldDiscardDash || dashCoverage <= 0.0;
}
`,"fs:#main-end":`
#ifdef ANTIALIASING
if (inRoundedDashGap) {
float pathCoverage = smoothedge(0.0, edgePixels);
float resolvedCapMultiplier =
min(pathCoverage, roundedDashResolvedCoverage) / max(pathCoverage, 1e-6);
dashCoverage = mix(
resolvedCapMultiplier,
roundedDashDutyCycle,
roundedDashSubPixelBlend
);
}
#endif
if (shouldDiscardDash) {
discard;
}
fragColor.a *= dashCoverage;
`}},it={inject:{"vs:#decl":`
in vec2 instanceDashArrays;
out vec2 vDashArray;
`,"vs:#main-end":`
vDashArray = instanceDashArrays;
`,"fs:#decl":`
layout(std140) uniform pathStyleUniforms {
bool dashGapPickable;
} pathStyle;
in vec2 vDashArray;
#define PI 3.141592653589793
`,"fs:#main-start":`
bool inDashGap = false;
float dashUnitLength = vDashArray.x + vDashArray.y;
if (dashUnitLength > 0.0 && scatterplot.stroked > 0.5) {
float _distToCenter = length(unitPosition) * outerRadiusPixels;
float innerRadius = innerUnitRadius * outerRadiusPixels;
if (_distToCenter >= innerRadius) {
float strokeWidth = (1.0 - innerUnitRadius) * outerRadiusPixels;
float midStrokeRadius = (innerUnitRadius + 1.0) * 0.5 * outerRadiusPixels;
float angle = atan(unitPosition.y, unitPosition.x) + PI;
float circumference = 2.0 * PI * midStrokeRadius;
float posAlongStroke = (angle / (2.0 * PI)) * circumference / strokeWidth;
float unitOffset = mod(posAlongStroke, dashUnitLength);
if (unitOffset > vDashArray.x) {
if (scatterplot.filled > 0.5) {
inDashGap = true;
} else {
if (!(pathStyle.dashGapPickable && bool(picking.isActive))) {
discard;
}
}
}
}
}
`,"fs:#main-end":`
if (inDashGap) {
float alphaFactor = fragColor.a / max(vLineColor.a, 0.001);
fragColor = vec4(vFillColor.rgb, vFillColor.a * alphaFactor);
fragColor = picking_filterPickingColor(fragColor);
fragColor = picking_filterHighlightColor(fragColor);
}
`}},nt={inject:{"vs:#decl":`
in vec2 instanceDashArrays;
out vec2 vDashArray;
`,"vs:#main-end":`
vDashArray = instanceDashArrays;
`,"fs:#decl":`
layout(std140) uniform pathStyleUniforms {
bool dashGapPickable;
} pathStyle;
in vec2 vDashArray;
#define PI 3.141592653589793
float getPerimeterPosition(vec2 fragUV, vec2 dims, vec4 radii, float lineWidth) {
float width = dims.x;
float height = dims.y;
float maxRadius = min(width, height) * 0.5;
float rBL = min(radii.w, maxRadius);
float rTL = min(radii.z, maxRadius);
float rTR = min(radii.x, maxRadius);
float rBR = min(radii.y, maxRadius);
vec2 p = fragUV * dims;
float leftLen = height - rBL - rTL;
float topLen = width - rTL - rTR;
float rightLen = height - rTR - rBR;
float bottomLen = width - rBR - rBL;
float arcBL = PI * 0.5 * rBL;
float arcTL = PI * 0.5 * rTL;
float arcTR = PI * 0.5 * rTR;
float arcBR = PI * 0.5 * rBR;
float pos = 0.0;
float distLeft = p.x;
float distRight = width - p.x;
float distBottom = p.y;
float distTop = height - p.y;
float minDist = min(min(distLeft, distRight), min(distBottom, distTop));
if (p.x < rBL && p.y < rBL) {
vec2 c = vec2(rBL, rBL);
vec2 d = p - c;
float angle = atan(-d.x, -d.y);
pos = angle / (PI * 0.5) * arcBL;
} else if (p.x < rTL && p.y > height - rTL) {
vec2 c = vec2(rTL, height - rTL);
vec2 d = p - c;
float angle = atan(d.y, -d.x);
pos = arcBL + leftLen + angle / (PI * 0.5) * arcTL;
} else if (p.x > width - rTR && p.y > height - rTR) {
vec2 c = vec2(width - rTR, height - rTR);
vec2 d = p - c;
float angle = atan(d.x, d.y);
pos = arcBL + leftLen + arcTL + topLen + angle / (PI * 0.5) * arcTR;
} else if (p.x > width - rBR && p.y < rBR) {
vec2 c = vec2(width - rBR, rBR);
vec2 d = p - c;
float angle = atan(-d.y, d.x);
pos = arcBL + leftLen + arcTL + topLen + arcTR + rightLen + angle / (PI * 0.5) * arcBR;
} else if (minDist == distLeft) {
pos = arcBL + clamp(p.y - rBL, 0.0, leftLen);
} else if (minDist == distTop) {
pos = arcBL + leftLen + arcTL + clamp(p.x - rTL, 0.0, topLen);
} else if (minDist == distRight) {
pos = arcBL + leftLen + arcTL + topLen + arcTR + clamp(height - rTR - p.y, 0.0, rightLen);
} else {
pos = arcBL + leftLen + arcTL + topLen + arcTR + rightLen + arcBR + clamp(width - rBR - p.x, 0.0, bottomLen);
}
return pos / lineWidth;
}
float getRectPerimeterPosition(vec2 fragUV, vec2 dims, float lineWidth) {
float width = dims.x;
float height = dims.y;
float distLeft = fragUV.x * width;
float distRight = (1.0 - fragUV.x) * width;
float distBottom = fragUV.y * height;
float distTop = (1.0 - fragUV.y) * height;
float minDist = min(min(distLeft, distRight), min(distBottom, distTop));
float pos = 0.0;
if (minDist == distLeft) {
pos = fragUV.y * height;
} else if (minDist == distTop) {
pos = height + fragUV.x * width;
} else if (minDist == distRight) {
pos = height + width + (1.0 - fragUV.y) * height;
} else {
pos = 2.0 * height + width + (1.0 - fragUV.x) * width;
}
return pos / lineWidth;
}
`,"fs:#main-start":`
bool inDashGap = false;
float dashUnitLength = vDashArray.x + vDashArray.y;
if (dashUnitLength > 0.0 && textBackground.stroked) {
float distToEdge;
bool hasRoundedCorners = textBackground.borderRadius != vec4(0.0);
if (hasRoundedCorners) {
distToEdge = round_rect(uv, dimensions, textBackground.borderRadius);
} else {
distToEdge = rect(uv, dimensions);
}
if (distToEdge <= vLineWidth && distToEdge >= 0.0) {
float posAlongStroke;
if (hasRoundedCorners) {
posAlongStroke = getPerimeterPosition(uv, dimensions, textBackground.borderRadius, vLineWidth);
} else {
posAlongStroke = getRectPerimeterPosition(uv, dimensions, vLineWidth);
}
float unitOffset = mod(posAlongStroke, dashUnitLength);
if (unitOffset > vDashArray.x) {
if (vFillColor.a > 0.0) {
inDashGap = true;
} else {
if (!(pathStyle.dashGapPickable && bool(picking.isActive))) {
discard;
}
}
}
}
}
`,"fs:#main-end":`
if (inDashGap) {
float alphaFactor = fragColor.a / max(vLineColor.a, 0.001);
fragColor = vec4(vFillColor.rgb, vFillColor.a * alphaFactor);
fragColor = picking_filterPickingColor(fragColor);
fragColor = picking_filterHighlightColor(fragColor);
}
`}},ot={inject:{"vs:#decl":`
in float instanceOffsets;
`,"vs:DECKGL_FILTER_SIZE":`
float offsetWidth = abs(instanceOffsets * 2.0) + 1.0;
size *= offsetWidth;
`,"vs:#main-end":`
float offsetWidth = abs(instanceOffsets * 2.0) + 1.0;
float offsetDir = sign(instanceOffsets);
vPathPosition.x = (vPathPosition.x + offsetDir) * offsetWidth - offsetDir;
vPathPosition.y *= offsetWidth;
vPathLength *= offsetWidth;
#ifdef DASH_ENABLED
if (pathStyle.dashUnits != 0) {
vDashArray *= offsetWidth;
}
vPathBounds *= offsetWidth;
#ifdef HIGH_PRECISION_DASH
vDashPathLength *= offsetWidth;
float restoredDashUnitLength = vDashArray.x + vDashArray.y;
float restoredDashPeriod = pathStyle.dashAlignMode == 0.0
? restoredDashUnitLength
: vDashPathLength /
max(round(vDashPathLength / max(restoredDashUnitLength, 0.0001)), 1.0);
vDashOffset = restoredDashPeriod > 0.0
? mod(dashOffsetAndLength.x * offsetWidth, restoredDashPeriod)
: 0.0;
#else
vDashOffset *= offsetWidth;
#endif
#endif
`,"fs:#main-end":`
#ifndef ANTIALIASING
if (abs(vPathPosition.x) > 1.0) {
discard;
}
#endif
`}},rt={getDashArray:{type:"accessor",value:[0,0]},getOffset:{type:"accessor",value:0},dashJustified:!1,dashGapPickable:!1,dashUnits:"widths"},ht={widths:0,pixels:1,meters:2,common:3},lt=["instanceDashArrays","instanceDashOffsets","instanceOffsets"];function dt({props:t,oldProps:a}){return!W(t.modelMatrix,a.modelMatrix,2)||t.coordinateSystem!==a.coordinateSystem||!W(t.coordinateOrigin,a.coordinateOrigin,1)}function N(t,a,s){const n=t.context.viewport;if(!(n instanceof Q)||n.zoom<12)return t.projectPosition(a,{autoOffset:!1});const i=tt([],[a[0],a[1],a[2]||0,1],s.modelMatrix),o=t.props.coordinateSystem==="default"?"lnglat":t.props.coordinateSystem;if(o==="lnglat"){if(Math.abs(i[1]-s.coordinateOrigin[1])>.25){let e=i[0];s.wrapLongitude&&(e=((e+180)%360+360)%360-180);const l=n.projectPosition([e,i[1],0]);return[l[0]-s.commonOrigin[0],l[1]-s.commonOrigin[1],i[2]*s.commonUnitsPerMeter[2]]}H(i,i,s.coordinateOrigin)}else o==="cartesian"&&H(i,i,s.coordinateOrigin);const r=i[1],h=et([],s.commonUnitsPerWorldUnit,s.commonUnitsPerWorldUnit2,r);return at([],i,h)}class V extends Z{constructor({dash:a=!1,offset:s=!1,dashMode:n,highPrecisionDash:i=!1}={}){const o=n??(i?"path":"segment");super({dash:a||i||n!==void 0,offset:s,dashMode:o,highPrecisionDash:o==="path"})}getLayerType(a){if("pathTesselator"in a.state)return"path";const s=a.constructor.layerName;return s==="ScatterplotLayer"?"scatterplot":s==="TextBackgroundLayer"?"textBackground":null}synchronizeAttributes(a){const s=a.getAttributeManager(),n=this.getLayerType(a);if(!s||!n)return!1;const i=s.getAttributes(),o=new Set;this.opts.dash&&o.add("instanceDashArrays"),n==="path"&&this.opts.dash&&this.opts.dashMode==="path"&&o.add("instanceDashOffsets"),n==="path"&&this.opts.offset&&o.add("instanceOffsets");let r=!1;for(const h of lt)i[h]&&!o.has(h)&&(s.remove([h]),r=!0);return o.has("instanceDashArrays")&&!i.instanceDashArrays&&(s.addInstanced({instanceDashArrays:{size:2,accessor:"getDashArray"}}),r=!0),o.has("instanceDashOffsets")&&!i.instanceDashOffsets&&(s.addInstanced({instanceDashOffsets:{size:2,accessor:["getPath"],update:this.calculateDashMetrics}}),r=!0),o.has("instanceOffsets")&&!i.instanceOffsets&&(s.addInstanced({instanceOffsets:{size:1,accessor:"getOffset"}}),r=!0),r}isEnabled(a){return this.getLayerType(a)!==null}getShaders(a){const s=a.getLayerType(this);if(!s)return null;if(s==="scatterplot"||s==="textBackground")return a.opts.dash?{modules:[{name:"pathStyle",inject:s==="scatterplot"?it.inject:nt.inject,uniformTypes:{dashGapPickable:"i32"}}]}:null;let n={};const i={};a.opts.dash&&(n=_(n,st),i.DASH_ENABLED=!0,a.opts.dashMode==="path"&&(i.HIGH_PRECISION_DASH=!0)),a.opts.offset&&(n=_(n,ot),i.PATH_STYLE_OFFSET=!0);const{inject:o}=n,r={name:"pathStyle",inject:o};return a.opts.dash&&(r.uniformTypes={dashAlignMode:"f32",dashGapPickable:"i32",dashUnits:"i32"}),{modules:[r],defines:i}}initializeState(a,s){s.synchronizeAttributes(this)}updateState(a,s){var n;if(s.isEnabled(this)){if(a.changeFlags.extensionsChanged){const i=s.synchronizeAttributes(this),o=this.getAttributeManager();if(o&&i){o.invalidateAll();for(const r of this.getModels())r.setBufferLayout(o.getBufferLayouts(r))}}if(s.opts.dash){const i=s.getLayerType(this);if(i==="path"&&s.opts.dashMode==="path"&&dt(a)&&((n=this.getAttributeManager())==null||n.invalidate("instanceDashOffsets")),i==="scatterplot"||i==="textBackground"){const o={dashGapPickable:!!this.props.dashGapPickable};this.setShaderModuleProps({pathStyle:o})}else{const o={dashAlignMode:this.props.dashJustified?1:0,dashGapPickable:!!this.props.dashGapPickable,dashUnits:ht[this.props.dashUnits??"widths"]};this.setShaderModuleProps({pathStyle:o})}}}}calculateDashMetrics(a,{startRow:s,endRow:n}){var b,y,B;const i=this.state.pathTesselator,o=i==null?void 0:i.vertexStarts,r=i==null?void 0:i.instanceCount,h=i==null?void 0:i.get("positions");if(!o||r===void 0||typeof(i==null?void 0:i.getPathSegmentIndices)!="function")throw new Error("PathStyleExtension requires PathLayer tessellation data for path dashes.");const e=(y=(b=this.props.data)==null?void 0:b.attributes)==null?void 0:y.getPath,l=ArrayBuffer.isView(e)?e:e==null?void 0:e.value,g=ArrayBuffer.isView(l),f=h&&(!e||i.normalize||((B=i.opts)==null?void 0:B.isWebGPU));if(e&&!g||!f&&!g)throw new Error("PathStyleExtension cannot calculate whole-path dash metrics from GPU-only getPath data; supply data.attributes.instanceDashOffsets.");const L=a.value,d=a.size,u=Math.max(0,s),A=Math.min(n,o.length-1);let D=3,P=3,x=0;if(!f){const c=l.BYTES_PER_ELEMENT;D=(e==null?void 0:e.size)||(this.props.positionFormat==="XY"?2:3),P=e!=null&&e.stride?e.stride/c:D,x=e!=null&&e.offset?e.offset/c:0}const p=new Array(3),R=J.getUniforms({viewport:this.context.viewport,modelMatrix:this.props.modelMatrix,coordinateSystem:this.props.coordinateSystem,coordinateOrigin:this.props.coordinateOrigin,autoWrapLongitude:this.wrapLongitude}),M=c=>{if(f)p[0]=h[c*3],p[1]=h[c*3+1],p[2]=h[c*3+2];else{const S=x+c*P;p[0]=l[S],p[1]=l[S+1],p[2]=D===3?l[S+2]:0}return p};a.startIndices=o;for(let c=u;c<A;c++){const S=o[c],I=Math.min(o[c+1]??r,r);L.fill(0,S*d,I*d);const $=i.getPathSegmentIndices(c);let T=0,U=-2,O=null;for(const v of $){const K=v*d;L[K]=T;const X=v===U+1&&O?O:N(this,M(v),R),E=N(this,M(v+1),R);T+=G(X,E),U=v,O=E}if(d>1)for(let v=S;v<I;v++)L[v*d+1]=T}}getDashOffsets(a){const s=[0],n=this.props.positionFormat==="XY"?2:3,i=Array.isArray(a[0]),o=i?a.length:a.length/n;let r,h;for(let e=0;e<o-1;e++)r=i?a[e]:a.slice(e*n,e*n+n),r=this.projectPosition(r,{autoOffset:!1}),e>0&&(s[e]=s[e-1]+G(h,r)),h=r;return s[o-1]=0,s}}V.defaultProps=rt;V.extensionName="PathStyleExtension";const Lt=t=>String(t??"").replace(/[&<>"']/g,a=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[a]),yt=t=>typeof t=="number"&&Number.isFinite(t)?t.toLocaleString("en-US"):"—",ft=6371.0088,m=Math.PI/180;function k(t,a,s,n){const i=(n-a)*m,o=(s-t)*m,r=Math.sin(i/2)**2+Math.cos(a*m)*Math.cos(n*m)*Math.sin(o/2)**2;return 2*ft*Math.asin(Math.min(1,Math.sqrt(r)))}const C=t=>Number.isFinite(t==null?void 0:t.lon)&&Number.isFinite(t==null?void 0:t.lat),j={min:4,max:15},ct={min:2,max:7};function F(t,a,{min:s,max:n}=j){return!(t>0)||!(a>0)?s:s+(n-s)*Math.sqrt(Math.min(1,t/a))}const z=t=>t.v4_addresses>0?t.v4_addresses:(t.v4_prefixes??0)+(t.v6_prefixes??0);function gt(t){const a=t*137.508%360,s=.72,n=.6+.08*(t%3-1),i=h=>(h+a/30)%12,o=s*Math.min(n,1-n),r=h=>Math.round(255*(n-o*Math.max(-1,Math.min(i(h)-3,9-i(h),1))));return[r(0),r(8),r(4)]}const ut=[140,148,160];function vt(t,a){const s=Math.max(0,...t.map(z)),n=t.map((e,l)=>({...e,index:l,prefixes:(e.v4_prefixes??0)+(e.v6_prefixes??0),colour:gt(l),radius:F(z(e),s,j),placed:C(e)})),i=Math.max(0,...a.map(e=>e.v4_addresses??0)),o=[],r=a.map(e=>{const l=(e.pops??[]).filter(d=>n[d.pop]),g=l.length?l.reduce((d,u)=>u.prefixes>d.prefixes?u:d):null,f=g?n[g.pop]:null,L=C(e);for(const d of l){const u=n[d.pop];L&&u.placed&&o.push({region:e.id,pop:u.index,prefixes:d.prefixes,km:k(e.lon,e.lat,u.lon,u.lat)})}return{...e,pop:f?f.index:-1,colour:f?f.colour:ut,radius:F(e.v4_addresses??0,i,ct),km:f&&L&&f.placed?k(e.lon,e.lat,f.lon,f.lat):null,placed:L}});o.sort((e,l)=>l.km-e.km);const h=new Map(n.map(e=>[e.code,e]));return{pops:n,regions:r,assignments:o,byCode:h}}function Pt(t){const a=t.country_name||t.country||"",s=t.city||t.region_name||"";return s&&s!==a?`${s}, ${a}`:a||s||"?"}const Dt=t=>`${t.city||t.name||t.airport||"?"} · ${t.code}`;function xt(t,{n:a=10,minKm:s=0}={}){const n=[];for(const i of t.assignments){if(i.km<s||n.length>=a)break;n.push({...i,regionRec:t.regions[i.region],popRec:t.pops[i.pop]})}return n}function St(t,a,{n:s=8}={}){const n=t.byCode.get(a);if(!n)return null;const i=n.regions??[],o=i.reduce((h,e)=>h+e.prefixes,0)||1,r=i.slice(0,s).map(h=>{const e=t.regions[h.id],l=e!=null&&e.placed&&n.placed?k(e.lon,e.lat,n.lon,n.lat):null;return{region:e,prefixes:h.prefixes,share:h.prefixes/o,km:l}});return{pop:n,prefixes:n.prefixes,regions:r,more:Math.max(0,i.length-s),countries:new Set(i.map(h=>h.country)).size}}const At=t=>new Set(((t==null?void 0:t.regions)??[]).map(a=>a.id));function Rt(t,a,{segs:s=null,alt:n=0,lift:i=0}={}){const[o,r,h,e]=[t[0]*m,t[1]*m,a[0]*m,a[1]*m],l=[Math.cos(r)*Math.cos(o),Math.cos(r)*Math.sin(o),Math.sin(r)],g=[Math.cos(e)*Math.cos(h),Math.cos(e)*Math.sin(h),Math.sin(e)],f=Math.acos(Math.max(-1,Math.min(1,l[0]*g[0]+l[1]*g[1]+l[2]*g[2]))),L=s??Math.max(1,Math.min(32,Math.ceil(f/(3*m)))),d=Math.sin(f),u=[];let A=t[0];for(let D=0;D<=L;D++){const P=D/L,x=d<1e-9?1-P:Math.sin((1-P)*f)/d,p=d<1e-9?P:Math.sin(P*f)/d,R=x*l[0]+p*g[0],M=x*l[1]+p*g[1],b=x*l[2]+p*g[2];let y=Math.atan2(M,R)/m;for(;y-A>180;)y-=360;for(;y-A<-180;)y+=360;A=y,u.push([y,Math.atan2(b,Math.hypot(R,M))/m,n+i*Math.sin(Math.PI*P)])}return u}function Mt(t,a,{pad:s=2}={}){if(!C(t))return null;let n=t.lon,i=t.lon,o=t.lat,r=t.lat;for(const e of a){if(!C(e))continue;let l=e.lon;for(;l-t.lon>180;)l-=360;for(;l-t.lon<-180;)l+=360;n=Math.min(n,l),i=Math.max(i,l),o=Math.min(o,e.lat),r=Math.max(r,e.lat)}if(n-=s,i+=s,o=Math.max(-85,o-s),r=Math.min(85,r+s),i-n>300)return null;const h=e=>((e+180)%360+360)%360-180;return[h(n),o,h(i),r]}const Y=["pops","regions","peering","backbone"],q=[...Y,"gateways","links","mesh","traffic"],w=[...Y,"gateways","links"];function bt(t){return t==null?new Set(w):t==="none"||t===""?new Set:new Set(String(t).split(",").filter(a=>q.includes(a)))}function Ct(t){const a=q.filter(s=>t.has(s));return a.length===w.length&&w.every(s=>t.has(s))?null:a.length?a.join(","):"none"}const Tt=t=>Number.isFinite(t)?`${Math.round(t).toLocaleString("en-US")} km`:"—";export{q as L,Y as P,bt as a,At as b,St as c,xt as d,Lt as e,yt as f,Rt as g,Mt as h,V as i,Tt as k,Ct as l,Dt as p,Pt as r,vt as s};
