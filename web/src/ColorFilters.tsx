// Daltonization filters for the comic art (applied with CSS `filter: url(#cb-<type>)`).
// corrected = rgb + shift · (rgb − simulate(rgb)): the colour difference a viewer can't see is
// moved into channels they can. Simulation matrices: Viénot et al. approximation in sRGB.

type M3 = number[][]

const SIMULATE: Record<string, M3> = {
  protanopia: [[0.567, 0.433, 0], [0.558, 0.442, 0], [0, 0.242, 0.758]],
  deuteranopia: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]],
  tritanopia: [[0.95, 0.05, 0], [0, 0.433, 0.567], [0, 0.475, 0.525]],
}

// Where the lost information goes: red/green loss → green and blue; blue loss → red and green.
const SHIFT: Record<string, M3> = {
  protanopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
  deuteranopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
  tritanopia: [[1, 0, 0.7], [0, 1, 0.7], [0, 0, 0]],
}

const I: M3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const mul = (a: M3, b: M3) => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)))
const sub = (a: M3, b: M3) => a.map((row, i) => row.map((v, j) => v - b[i][j]))
const add = (a: M3, b: M3) => a.map((row, i) => row.map((v, j) => v + b[i][j]))

function daltonize(type: string): string {
  const m = add(I, mul(SHIFT[type], sub(I, SIMULATE[type])))
  return [...m.map((r) => [...r.map((v) => v.toFixed(4)), 0, 0].join(' ')), '0 0 0 1 0'].join('  ')
}

export default function ColorFilters() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      {Object.keys(SIMULATE).map((type) => (
        <filter key={type} id={`cb-${type}`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={daltonize(type)} />
        </filter>
      ))}
    </svg>
  )
}
