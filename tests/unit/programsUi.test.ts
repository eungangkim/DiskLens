import { describe, expect, it } from 'vitest'
import { findProgramForPath } from '../../src/renderer/src/lib/programLink.ts'
import { visiblePrograms } from '../../src/renderer/src/lib/programList.ts'
import type { InstalledProgram } from '../../src/shared/types.ts'

const base = {
  sizeSource: 'unknown',
  scope: 'machine',
  canUninstall: false,
  match: { ruleId: null, safety: 'unknown', cleanable: false, canDelete: false }
} as const

const p = (over: Partial<InstalledProgram> & { id: string; name: string }): InstalledProgram => ({
  ...base,
  isSystemComponent: false,
  ...over
})

describe('프로그램 목록 정렬·검색·시스템 구성요소 토글', () => {
  const list = [
    p({ id: '1', name: 'Zeta', estimatedSizeBytes: 100, installDate: '2020-01-01' }),
    p({
      id: '2',
      name: 'alpha',
      estimatedSizeBytes: 900,
      installDate: '2023-05-05',
      publisher: 'Acme'
    }),
    p({ id: '3', name: 'Mid' }),
    p({ id: '4', name: 'Hidden Part', isSystemComponent: true, estimatedSizeBytes: 5000 })
  ]
  const ids = (xs: InstalledProgram[]) => xs.map((x) => x.id)
  const opts = { includeSystem: false, query: '', sort: 'size' as const }

  it('기본은 크기순, 크기를 모르는 프로그램은 맨 뒤, 시스템 구성요소는 숨김', () => {
    expect(ids(visiblePrograms(list, opts))).toEqual(['2', '1', '3'])
  })

  it('토글을 켜면 시스템 구성요소도 보인다', () => {
    expect(ids(visiblePrograms(list, { ...opts, includeSystem: true }))[0]).toBe('4')
  })

  it('이름순(가나다/ABC, 대소문자 무시)과 설치일 최신순', () => {
    expect(ids(visiblePrograms(list, { ...opts, sort: 'name' }))).toEqual(['2', '3', '1'])
    expect(ids(visiblePrograms(list, { ...opts, sort: 'date' }))).toEqual(['2', '1', '3'])
  })

  it('검색은 이름과 게시자에서 대소문자 무시로 찾는다', () => {
    expect(ids(visiblePrograms(list, { ...opts, query: 'ALP' }))).toEqual(['2'])
    expect(ids(visiblePrograms(list, { ...opts, query: 'acme' }))).toEqual(['2'])
    expect(visiblePrograms(list, { ...opts, query: 'zzz' })).toEqual([])
  })
})

describe('폴더 ↔ 프로그램 연결', () => {
  const programs = [
    p({ id: 'a', name: 'Outer', installLocation: 'C:\\Program Files\\Suite' }),
    p({ id: 'b', name: 'Inner', installLocation: 'C:\\Program Files\\Suite\\Plugin' }),
    p({ id: 'c', name: 'NoPlace' })
  ]

  it('설치 폴더와 그 하위는 프로그램으로 연결되고, 가장 깊은 설치 폴더가 이긴다', () => {
    expect(findProgramForPath(programs, 'C:\\Program Files\\Suite')?.id).toBe('a')
    expect(findProgramForPath(programs, 'c:\\program files\\suite\\bin\\x')?.id).toBe('a')
    expect(findProgramForPath(programs, 'C:\\Program Files\\Suite\\Plugin\\data')?.id).toBe('b')
  })

  it('이름만 비슷한 형제 폴더나 상위 폴더는 연결하지 않는다', () => {
    expect(findProgramForPath(programs, 'C:\\Program Files\\Suite2')).toBeNull()
    expect(findProgramForPath(programs, 'C:\\Program Files')).toBeNull()
    expect(findProgramForPath([], 'C:\\x')).toBeNull()
  })
})
