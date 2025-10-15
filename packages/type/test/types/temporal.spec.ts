import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'

import * as t from '../../src/temporal-polyfil.ts'

describe('TemporalType - PlainDate', () => {
  const plainDateType = t.plainDate()

  describe('decode (string -> Temporal.PlainDate)', () => {
    it('should decode ISO date string to Temporal.PlainDate', () => {
      const input = '2021-01-01'
      const result = plainDateType.decode(input)

      expect(result).toBeInstanceOf(Temporal.PlainDate)
      expect(result.toString()).toBe('2021-01-01')
      expect(result.year).toBe(2021)
      expect(result.month).toBe(1)
      expect(result.day).toBe(1)
    })

    it('should decode leap year date correctly', () => {
      const input = '2024-02-29'
      const result = plainDateType.decode(input)

      expect(result).toBeInstanceOf(Temporal.PlainDate)
      expect(result.toString()).toBe('2024-02-29')
    })

    it('should reject invalid date format', () => {
      expect(() => plainDateType.decode('2021/01/01')).toThrow()
    })

    it('should reject invalid date string', () => {
      expect(() => plainDateType.decode('not-a-date')).toThrow()
    })

    it('should reject date with time component', () => {
      expect(() => plainDateType.decode('2021-01-01T12:00:00')).toThrow()
    })
  })

  describe('encode (Temporal.PlainDate -> string)', () => {
    it('should encode Temporal.PlainDate to ISO string', () => {
      const input = Temporal.PlainDate.from('2021-01-01')
      const result = plainDateType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('2021-01-01')
    })

    it('should encode leap year date correctly', () => {
      const input = Temporal.PlainDate.from('2024-02-29')
      const result = plainDateType.encode(input)

      expect(result).toBe('2024-02-29')
    })
  })
})

describe('TemporalType - PlainDateTime', () => {
  const plainDateTimeType = t.plainDatetime()

  describe('decode (string -> Temporal.PlainDateTime)', () => {
    it('should decode ISO datetime string to Temporal.PlainDateTime', () => {
      const input = '2021-01-01T12:30:45.123'
      const result = plainDateTimeType.decode(input)

      expect(result).toBeInstanceOf(Temporal.PlainDateTime)
      expect(result.year).toBe(2021)
      expect(result.month).toBe(1)
      expect(result.day).toBe(1)
      expect(result.hour).toBe(12)
      expect(result.minute).toBe(30)
      expect(result.second).toBe(45)
      expect(result.millisecond).toBe(123)
    })

    it('should decode datetime without seconds', () => {
      const input = '2021-01-01T12:30:00.000'
      const result = plainDateTimeType.decode(input)

      expect(result).toBeInstanceOf(Temporal.PlainDateTime)
      expect(result.toString()).toContain('2021-01-01T12:30:00')
    })

    it('should reject invalid datetime format', () => {
      expect(() => plainDateTimeType.decode('2021-01-01 12:30:45')).toThrow()
    })

    it('should reject datetime with timezone', () => {
      expect(() => plainDateTimeType.decode('2021-01-01T12:30:45Z')).toThrow()
    })
  })

  describe('encode (Temporal.PlainDateTime -> string)', () => {
    it('should encode Temporal.PlainDateTime to ISO string', () => {
      const input = Temporal.PlainDateTime.from('2021-01-01T12:30:45.123')
      const result = plainDateTimeType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('2021-01-01T12:30:45.123000')
    })

    it('should encode datetime with milliseconds', () => {
      const input = Temporal.PlainDateTime.from('2021-06-15T08:15:30.500')
      const result = plainDateTimeType.encode(input)

      expect(result).toBe('2021-06-15T08:15:30.500000')
    })
  })
})

describe('TemporalType - ZonedDateTime', () => {
  const zonedDateTimeType = t.zonedDatetime()

  describe('decode (string -> Temporal.ZonedDateTime)', () => {
    it('should decode ISO datetime string to Temporal.ZonedDateTime in UTC', () => {
      const input = '2021-01-01T12:30:45.123Z'
      const result = zonedDateTimeType.decode(input)

      expect(result).toBeInstanceOf(Temporal.ZonedDateTime)
      expect(result.year).toBe(2021)
      expect(result.month).toBe(1)
      expect(result.day).toBe(1)
      expect(result.hour).toBe(12)
      expect(result.minute).toBe(30)
      expect(result.second).toBe(45)
      expect(result.timeZoneId).toBe('UTC')
    })

    it('should decode instant string to Temporal.ZonedDateTime', () => {
      const input = '2021-06-15T08:00:00Z'
      const result = zonedDateTimeType.decode(input)

      expect(result).toBeInstanceOf(Temporal.ZonedDateTime)
      expect(result.timeZoneId).toBe('UTC')
    })

    it('should reject invalid datetime format', () => {
      expect(() => zonedDateTimeType.decode('not-a-datetime')).toThrow()
    })
  })

  describe('encode (Temporal.ZonedDateTime -> string)', () => {
    it('should encode Temporal.ZonedDateTime to ISO string', () => {
      const input = Temporal.Instant.from(
        '2021-01-01T12:30:45.123Z',
      ).toZonedDateTimeISO('UTC')
      const result = zonedDateTimeType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('2021-01-01T12:30:45.123Z')
    })

    it('should encode with UTC timezone marker', () => {
      const input = Temporal.Instant.from(
        '2021-06-15T08:00:00Z',
      ).toZonedDateTimeISO('UTC')
      const result = zonedDateTimeType.encode(input)

      expect(result).toBe('2021-06-15T08:00:00.000Z')
      expect(result).toContain('Z')
      expect(result).not.toContain('[UTC]')
    })
  })
})

describe('TemporalType - PlainTime', () => {
  const plainTimeType = t.plainTime()

  describe('decode (string -> Temporal.PlainTime)', () => {
    it('should decode ISO time string to Temporal.PlainTime', () => {
      const input = '12:30:45.123'
      const result = plainTimeType.decode(input)

      expect(result).toBeInstanceOf(Temporal.PlainTime)
      expect(result.hour).toBe(12)
      expect(result.minute).toBe(30)
      expect(result.second).toBe(45)
      expect(result.millisecond).toBe(123)
    })

    it('should decode time without milliseconds', () => {
      const input = '08:15:30.000'
      const result = plainTimeType.decode(input)

      expect(result).toBeInstanceOf(Temporal.PlainTime)
      expect(result.hour).toBe(8)
      expect(result.minute).toBe(15)
      expect(result.second).toBe(30)
    })

    it('should decode midnight correctly', () => {
      const input = '00:00:00.000'
      const result = plainTimeType.decode(input)

      expect(result.hour).toBe(0)
      expect(result.minute).toBe(0)
      expect(result.second).toBe(0)
    })

    it('should decode time without seconds', () => {
      const input = '12:30:00.000'
      const result = plainTimeType.decode(input)

      expect(result.hour).toBe(12)
      expect(result.minute).toBe(30)
    })

    it('should reject invalid time string', () => {
      expect(() => plainTimeType.decode('25:00:00')).toThrow()
    })
  })

  describe('encode (Temporal.PlainTime -> string)', () => {
    it('should encode Temporal.PlainTime to ISO string', () => {
      const input = Temporal.PlainTime.from('12:30:45.123')
      const result = plainTimeType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('12:30:45.123000')
    })

    it('should encode midnight correctly', () => {
      const input = Temporal.PlainTime.from('00:00:00')
      const result = plainTimeType.encode(input)

      expect(result).toBe('00:00:00.000000')
    })
  })
})

describe('TemporalType - Duration', () => {
  const durationType = t.duration()

  describe('decode (string -> Temporal.Duration)', () => {
    it('should decode ISO duration string to Temporal.Duration', () => {
      const input = 'PT1H30M'
      const result = durationType.decode(input)

      expect(result).toBeInstanceOf(Temporal.Duration)
      expect(result.hours).toBe(1)
      expect(result.minutes).toBe(30)
    })

    it('should decode duration with days', () => {
      const input = 'P1DT12H'
      const result = durationType.decode(input)

      expect(result).toBeInstanceOf(Temporal.Duration)
      expect(result.days).toBe(1)
      expect(result.hours).toBe(12)
    })

    it('should decode duration with years and months', () => {
      const input = 'P1Y2M3D'
      const result = durationType.decode(input)

      expect(result.years).toBe(1)
      expect(result.months).toBe(2)
      expect(result.days).toBe(3)
    })

    it('should decode duration with milliseconds', () => {
      const input = 'PT0.123S'
      const result = durationType.decode(input)

      expect(result.milliseconds).toBe(123)
    })

    it('should reject invalid duration format', () => {
      expect(() => durationType.decode('1 hour')).toThrow()
    })

    it('should reject invalid duration string', () => {
      expect(() => durationType.decode('not-a-duration')).toThrow()
    })
  })

  describe('encode (Temporal.Duration -> string)', () => {
    it('should encode Temporal.Duration to ISO string', () => {
      const input = Temporal.Duration.from({ hours: 1, minutes: 30 })
      const result = durationType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('PT1H30M0.000000S')
    })

    it('should encode duration with days', () => {
      const input = Temporal.Duration.from({ days: 1, hours: 12 })
      const result = durationType.encode(input)

      expect(result).toBe('P1DT12H0.000000S')
    })

    it('should encode complex duration', () => {
      const input = Temporal.Duration.from({
        years: 1,
        months: 2,
        days: 3,
        hours: 4,
        minutes: 5,
        seconds: 6,
      })
      const result = durationType.encode(input)

      expect(result).toBe('P1Y2M3DT4H5M6.000000S')
    })
  })
})

describe('TemporalType - PlainYearMonth', () => {
  const plainYearMonthType = t.plainYearMonth()

  describe('decode (string -> Temporal.PlainYearMonth)', () => {
    it('should decode year-month string to Temporal.PlainYearMonth', () => {
      const input = '2021-01'
      const result = plainYearMonthType.decode(input)

      expect(result).toBeInstanceOf(Temporal.PlainYearMonth)
      expect(result.year).toBe(2021)
      expect(result.month).toBe(1)
    })

    it('should decode December correctly', () => {
      const input = '2021-12'
      const result = plainYearMonthType.decode(input)

      expect(result.month).toBe(12)
    })

    it('should reject invalid format', () => {
      expect(() => plainYearMonthType.decode('2021-1')).toThrow()
    })

    it('should reject invalid month', () => {
      expect(() => plainYearMonthType.decode('2021-13')).toThrow()
    })

    it('should reject date string', () => {
      expect(() => plainYearMonthType.decode('2021-01-01')).toThrow()
    })
  })

  describe('encode (Temporal.PlainYearMonth -> string)', () => {
    it('should encode Temporal.PlainYearMonth to string', () => {
      const input = Temporal.PlainYearMonth.from('2021-01')
      const result = plainYearMonthType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('2021-01')
    })

    it('should encode December correctly', () => {
      const input = Temporal.PlainYearMonth.from('2021-12')
      const result = plainYearMonthType.encode(input)

      expect(result).toBe('2021-12')
    })
  })
})

describe('TemporalType - PlainMonthDay', () => {
  const plainMonthDayType = t.plainMonthDay()

  describe('decode (string -> Temporal.PlainMonthDay)', () => {
    it('should decode month-day string to Temporal.PlainMonthDay', () => {
      const input = '01-15'
      const result = plainMonthDayType.decode(input)

      expect(result).toBeInstanceOf(Temporal.PlainMonthDay)
      expect(result.monthCode).toBe('M01')
      expect(result.day).toBe(15)
    })

    it('should decode leap day correctly', () => {
      const input = '02-29'
      const result = plainMonthDayType.decode(input)

      expect(result.monthCode).toBe('M02')
      expect(result.day).toBe(29)
    })

    it('should reject invalid format', () => {
      expect(() => plainMonthDayType.decode('1-15')).toThrow()
    })

    it('should reject invalid day', () => {
      expect(() => plainMonthDayType.decode('01-32')).toThrow()
    })

    it('should reject date string', () => {
      expect(() => plainMonthDayType.decode('2021-01-15')).toThrow()
    })
  })

  describe('encode (Temporal.PlainMonthDay -> string)', () => {
    it('should encode Temporal.PlainMonthDay to string', () => {
      const input = Temporal.PlainMonthDay.from('01-15')
      const result = plainMonthDayType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('01-15')
    })

    it('should encode leap day correctly', () => {
      const input = Temporal.PlainMonthDay.from('02-29')
      const result = plainMonthDayType.encode(input)

      expect(result).toBe('02-29')
    })
  })
})

describe('TemporalType - Edge Cases', () => {
  describe('with optional', () => {
    const optionalDate = t.plainDate().optional()

    it('should handle undefined with optional in decode', () => {
      const result = optionalDate.decode(undefined)
      expect(result).toBeUndefined()
    })

    it('should decode valid value with optional', () => {
      const result = optionalDate.decode('2021-01-01')
      expect(result).toBeInstanceOf(Temporal.PlainDate)
      expect(result?.toString()).toBe('2021-01-01')
    })

    it('should handle undefined with optional in encode', () => {
      const result = optionalDate.encode(undefined)
      expect(result).toBeUndefined()
    })

    it('should encode valid value with optional', () => {
      const input = Temporal.PlainDate.from('2021-01-01')
      const result = optionalDate.encode(input)
      expect(result).toBe('2021-01-01')
    })
  })

  describe('with nullable', () => {
    const nullableTime = t.plainTime().nullable()

    it('should handle null with nullable in decode', () => {
      const result = nullableTime.decode(null)
      expect(result).toBeNull()
    })

    it('should decode valid value with nullable', () => {
      const result = nullableTime.decode('12:30:45.123')
      expect(result).toBeInstanceOf(Temporal.PlainTime)
    })

    it('should handle null with nullable in encode', () => {
      const result = nullableTime.encode(null)
      expect(result).toBeNull()
    })
  })

  describe('with default', () => {
    const defaultDate = Temporal.PlainDate.from('2021-01-01')
    const dateWithDefault = t.plainDate().default(defaultDate)

    it('should use default when undefined in decode', () => {
      const result = dateWithDefault.decode(undefined)
      expect(result.toString()).toBe('2021-01-01')
    })

    it('should decode provided value instead of default', () => {
      const result = dateWithDefault.decode('2022-06-15')
      expect(result.toString()).toBe('2022-06-15')
    })
  })

  describe('roundtrip encode/decode', () => {
    it('should roundtrip PlainDate correctly', () => {
      const original = Temporal.PlainDate.from('2021-06-15')
      const dateType = t.plainDate()
      const encoded = dateType.encode(original)
      const decoded = dateType.decode(encoded)

      expect(decoded.toString()).toBe(original.toString())
    })

    it('should roundtrip PlainDateTime correctly', () => {
      const original = Temporal.PlainDateTime.from('2021-06-15T12:30:45.123')
      const datetimeType = t.plainDatetime()
      const encoded = datetimeType.encode(original)
      const decoded = datetimeType.decode(encoded)

      expect(decoded.toString()).toBe(original.toString())
    })

    it('should roundtrip Duration correctly', () => {
      const original = Temporal.Duration.from({
        hours: 2,
        minutes: 30,
        seconds: 45,
      })
      const durationType = t.duration()
      const encoded = durationType.encode(original)
      const decoded = durationType.decode(encoded)

      expect(decoded.hours).toBe(original.hours)
      expect(decoded.minutes).toBe(original.minutes)
      expect(decoded.seconds).toBe(original.seconds)
    })
  })
})
