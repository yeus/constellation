;(function (global) {
  if (typeof Object.hasOwn !== 'function') {
    Object.hasOwn = function (object, property) {
      return Object.prototype.hasOwnProperty.call(object, property)
    }
  }

  if (typeof global.AggregateError !== 'function') {
    var AggregateErrorPolyfill = function (errors, message) {
      var error = Error.call(this, message)
      this.name = 'AggregateError'
      this.message = message === undefined ? '' : String(message)
      this.errors = Array.from(errors)
      if (error.stack) this.stack = error.stack
    }
    AggregateErrorPolyfill.prototype = Object.create(Error.prototype)
    AggregateErrorPolyfill.prototype.constructor = AggregateErrorPolyfill
    global.AggregateError = AggregateErrorPolyfill
  }

  if (typeof Promise.any !== 'function') {
    Promise.any = function (iterable) {
      var values = Array.from(iterable)
      return new Promise(function (resolve, reject) {
        if (values.length === 0) {
          reject(new global.AggregateError([], 'All promises were rejected'))
          return
        }
        var errors = new Array(values.length)
        var remaining = values.length
        values.forEach(function (value, index) {
          Promise.resolve(value).then(resolve, function (error) {
            errors[index] = error
            remaining -= 1
            if (remaining === 0) {
              reject(new global.AggregateError(errors, 'All promises were rejected'))
            }
          })
        })
      })
    }
  }

  if (typeof Promise.allSettled !== 'function') {
    Promise.allSettled = function (iterable) {
      return Promise.all(
        Array.from(iterable).map(function (value) {
          return Promise.resolve(value).then(
            function (result) {
              return { status: 'fulfilled', value: result }
            },
            function (reason) {
              return { status: 'rejected', reason: reason }
            },
          )
        }),
      )
    }
  }

  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function () {
      var resolve
      var reject
      var promise = new Promise(function (res, rej) {
        resolve = res
        reject = rej
      })
      return { promise: promise, resolve: resolve, reject: reject }
    }
  }

  var at = function (index) {
    var object = Object(this)
    var length = Number(object.length) || 0
    var relative = Number(index) || 0
    var position = relative < 0 ? length + Math.ceil(relative) : Math.floor(relative)
    if (position < 0 || position >= length) return undefined
    return object[position]
  }
  if (typeof Array.prototype.at !== 'function') {
    Object.defineProperty(Array.prototype, 'at', { configurable: true, writable: true, value: at })
  }
  if (typeof String.prototype.at !== 'function') {
    Object.defineProperty(String.prototype, 'at', { configurable: true, writable: true, value: at })
  }

  if (typeof Array.prototype.findLast !== 'function') {
    Object.defineProperty(Array.prototype, 'findLast', {
      configurable: true,
      writable: true,
      value: function (predicate, thisArg) {
        if (typeof predicate !== 'function')
          throw new TypeError('findLast predicate must be a function')
        var object = Object(this)
        var length = Number(object.length) >>> 0
        for (var index = length - 1; index >= 0; index -= 1) {
          var value = object[index]
          if (predicate.call(thisArg, value, index, object)) return value
        }
        return undefined
      },
    })
  }

  if (typeof String.prototype.replaceAll !== 'function') {
    Object.defineProperty(String.prototype, 'replaceAll', {
      configurable: true,
      writable: true,
      value: function (searchValue, replaceValue) {
        var input = String(this)
        if (searchValue instanceof RegExp) {
          if (!searchValue.global)
            throw new TypeError('replaceAll requires a global regular expression')
          return input.replace(searchValue, replaceValue)
        }
        var search = String(searchValue)
        if (search === '') return input.split('').join(String(replaceValue))
        if (typeof replaceValue !== 'function')
          return input.split(search).join(String(replaceValue))
        var output = ''
        var cursor = 0
        var index = input.indexOf(search)
        while (index !== -1) {
          output += input.slice(cursor, index) + String(replaceValue(search, index, input))
          cursor = index + search.length
          index = input.indexOf(search, cursor)
        }
        return output + input.slice(cursor)
      },
    })
  }

  if (
    typeof global.AbortSignal === 'function' &&
    typeof global.AbortController === 'function' &&
    typeof global.AbortSignal.timeout !== 'function'
  ) {
    global.AbortSignal.timeout = function (milliseconds) {
      var controller = new global.AbortController()
      global.setTimeout(
        function () {
          controller.abort()
        },
        Math.max(0, Number(milliseconds) || 0),
      )
      return controller.signal
    }

    if (
      typeof global.AbortSignal === 'function' &&
      typeof global.AbortSignal.prototype.throwIfAborted !== 'function'
    ) {
      global.AbortSignal.prototype.throwIfAborted = function () {
        if (!this.aborted) return
        if ('reason' in this && this.reason !== undefined) throw this.reason
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
    }
  }

  if (
    global.crypto &&
    typeof global.crypto.getRandomValues === 'function' &&
    typeof global.crypto.randomUUID !== 'function'
  ) {
    global.crypto.randomUUID = function () {
      var bytes = new Uint8Array(16)
      global.crypto.getRandomValues(bytes)
      bytes[6] = (bytes[6] & 15) | 64
      bytes[8] = (bytes[8] & 63) | 128
      var hex = Array.from(bytes, function (byte) {
        return byte.toString(16).padStart(2, '0')
      }).join('')
      return (
        hex.slice(0, 8) +
        '-' +
        hex.slice(8, 12) +
        '-' +
        hex.slice(12, 16) +
        '-' +
        hex.slice(16, 20) +
        '-' +
        hex.slice(20)
      )
    }
  }
})(typeof globalThis === 'object' ? globalThis : window)
