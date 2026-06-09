// Minimal BPE tokenizer engine for encode-only use.
// Extracted from @lenml/tokenizers (fork of transformers.js).
// Only BPE model + the normalizers/pre-tokenizers our bundled models use.

// ============================================================================
// Utilities (inlined — no external imports)
// ============================================================================

/**
 * A base class for creating callable objects.
 * See https://stackoverflow.com/q/76073890 for more information.
 *
 * @type {new () => {(...args: any[]): any, _call(...args: any[]): any}}
 */
const Callable = /** @type {any} */ (
  class {
    /**
     * Creates a new instance of the Callable class.
     */
    constructor() {
      /**
       * Creates a closure that delegates to a private method '_call' with the given arguments.
       * @type {any}
       * @param {...any} args Zero or more arguments to pass to the '_call' method.
       * @returns {*} The result of calling the '_call' method.
       */
      let closure = function (...args) {
        return closure._call(...args);
      };
      return Object.setPrototypeOf(closure, new.target.prototype);
    }

    /**
     * This method should be implemented in subclasses to provide the
     * functionality of the callable object.
     *
     * @param {any[]} args
     * @throws {Error} If the subclass does not implement the `_call` method.
     */
    _call(...args) {
      throw Error("Must implement _call method in subclass");
    }
  }
);

/**
 * Efficient Heap-based Implementation of a Priority Queue.
 * It uses an array-based binary heap, where the root is at index `0`, and the
 * children of node `i` are located at indices `2i + 1` and `2i + 2`, respectively.
 */
class PriorityQueue {
  /**
   * Create a new PriorityQueue.
   * @param {function(any, any): boolean} comparator Comparator function to determine priority. Defaults to a MaxHeap.
   */
  constructor(comparator = (a, b) => a > b, maxSize = Infinity) {
    this._heap = [];
    this._comparator = comparator;
    this._maxSize = maxSize;
  }

  /**
   * The size of the queue
   */
  get size() {
    return this._heap.length;
  }

  /**
   * Check if the queue is empty.
   * @returns {boolean} `true` if the queue is empty, `false` otherwise.
   */
  isEmpty() {
    return this.size === 0;
  }

  /**
   * Return the element with the highest priority in the queue.
   * @returns {any} The highest priority element in the queue.
   */
  peek() {
    return this._heap[0];
  }

  /**
   * Add one or more elements to the queue.
   * @param  {...any} values The values to push into the queue.
   * @returns {number} The new size of the queue.
   */
  push(...values) {
    return this.extend(values);
  }

  /**
   * Add multiple elements to the queue.
   * @param {any[]} values The values to push into the queue.
   * @returns {number} The new size of the queue.
   */
  extend(values) {
    for (const value of values) {
      if (this.size < this._maxSize) {
        this._heap.push(value);
        this._siftUp();
      } else {
        // Get index of value with the lowest priority
        const smallest = this._smallest();

        // If the new value has higher priority than the smallest value in the heap
        // then replace the smallest value with the new value and update the heap
        if (this._comparator(value, this._heap[smallest])) {
          this._heap[smallest] = value;
          this._siftUpFrom(smallest);
        }
      }
    }
    return this.size;
  }

  /**
   * Remove and return the element with the highest priority in the queue.
   * @returns {any} The element with the highest priority in the queue.
   */
  pop() {
    const poppedValue = this.peek();
    const bottom = this.size - 1;
    if (bottom > 0) {
      this._swap(0, bottom);
    }
    this._heap.pop();
    this._siftDown();
    return poppedValue;
  }

  /**
   * Replace the element with the highest priority in the queue with a new value.
   * @param {*} value The new value.
   * @returns {*} The replaced value.
   */
  replace(value) {
    const replacedValue = this.peek();
    this._heap[0] = value;
    this._siftDown();
    return replacedValue;
  }

  /**
   * Compute the index for the parent of the node at index `i`.
   * @param {number} i The index of the node to get the parent of.
   * @returns {number} The index of the parent node.
   * @private
   */
  _parent(i) {
    return ((i + 1) >>> 1) - 1;
  }

  /**
   * Compute the index for the left child of the node at index `i`.
   * @param {number} i The index of the node to get the left child of.
   * @returns {number} The index of the left child.
   * @private
   */
  _left(i) {
    return (i << 1) + 1;
  }

  /**
   * Compute the index for the right child of the node at index `i`.
   * @param {number} i The index of the node to get the right child of.
   * @returns {number} The index of the right child.
   * @private
   */
  _right(i) {
    return (i + 1) << 1;
  }

  /**
   * Check if the element at index `i` is greater than the element at index `j`.
   * @param {number} i The index of the first element to compare.
   * @param {number} j The index of the second element to compare.
   * @returns {boolean} `true` if the element at index `i` is greater than the element at index `j`, `false` otherwise.
   * @private
   */
  _greater(i, j) {
    return this._comparator(this._heap[i], this._heap[j]);
  }

  /**
   * Swap the elements at indices `i` and `j`.
   * @param {number} i The index of the first element to swap.
   * @param {number} j The index of the second element to swap.
   * @private
   */
  _swap(i, j) {
    const temp = this._heap[i];
    this._heap[i] = this._heap[j];
    this._heap[j] = temp;
  }

  /**
   * Maintain the heap property by updating positions in the heap,
   * starting at the last element and moving up the heap.
   * @private
   */
  _siftUp() {
    this._siftUpFrom(this.size - 1);
  }

  /**
   * Helper function to sift up from a given node.
   * @param {number} node The index of the node to start sifting up from.
   */
  _siftUpFrom(node) {
    while (node > 0 && this._greater(node, this._parent(node))) {
      this._swap(node, this._parent(node));
      node = this._parent(node);
    }
  }

  /**
   * Maintain the heap property by updating positions in the heap,
   * starting at the first element and moving down the heap.
   * @private
   */
  _siftDown() {
    let node = 0;
    while (
      (this._left(node) < this.size && this._greater(this._left(node), node)) ||
      (this._right(node) < this.size && this._greater(this._right(node), node))
    ) {
      const maxChild =
        this._right(node) < this.size &&
        this._greater(this._right(node), this._left(node))
          ? this._right(node)
          : this._left(node);
      this._swap(node, maxChild);
      node = maxChild;
    }
  }

  /**
   * Get the index of the smallest element in the heap. Since we use an array-based heap,
   * the index can be computed without needing to traverse the heap.
   * @private
   */
  _smallest() {
    return 2 ** Math.floor(Math.log2(this.size)) - 1;
  }
}

/**
 * A data structure which uses a trie to split a string into tokens based on a dictionary.
 * It can also use a regular expression to preprocess the input text before splitting.
 *
 * NOTE: To ensure multi-byte characters are handled correctly, we operate at byte-level instead of character-level.
 */
class DictionarySplitter {
  /**
   * @param {string[]} dictionary The dictionary of words to use for splitting.
   */
  constructor(dictionary) {
    this.trie = this._buildTrie(dictionary);
  }

  /**
   * Builds a trie from the given dictionary.
   * @param {string[]} dictionary The dictionary of words to build the trie from.
   * @returns {Object} The root node of the trie.
   * @private
   */
  _buildTrie(dictionary) {
    const trie = Object.create(null);
    for (const word of dictionary) {
      let node = trie;
      for (let i = 0; i < word.length; ++i) {
        node = node[word[i]] ??= Object.create(null);
      }
      node.end = word;
    }
    return trie;
  }

  /**
   * Splits the input text into tokens based on the dictionary.
   * @param {string} text The input text to split.
   * @returns {string[]} An array of tokens.
   */
  split(text) {
    const result = [];
    const n = text.length;
    let start = 0;
    let i = 0;

    while (i < n) {
      let node = this.trie;
      let match = null;
      let j = i;

      while (j < n && (node = node[text[j]])) {
        if (node.end) {
          // Always keep the last (i.e., longest) match.
          match = node.end;
        }
        ++j;
      }

      if (match) {
        if (i > start) {
          result.push(text.slice(start, i));
        }
        result.push(match);
        i += match.length;
        start = i;
      } else {
        ++i;
      }
    }
    if (start < n) {
      result.push(text.slice(start));
    }
    return result;
  }
}

/**
 * A simple Least Recently Used (LRU) cache implementation in JavaScript.
 * This cache stores key-value pairs and evicts the least recently used item
 * when the capacity is exceeded.
 */
class LRUCache {
  /**
   * Creates an LRUCache instance.
   * @param {number} capacity The maximum number of items the cache can hold.
   */
  constructor(capacity) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  /**
   * Retrieves the value associated with the given key and marks the key as recently used.
   * @param {any} key The key to retrieve.
   * @returns {any} The value associated with the key, or undefined if the key does not exist.
   */
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * Inserts or updates the key-value pair in the cache.
   * If the key already exists, it is updated and marked as recently used.
   * If the cache exceeds its capacity, the least recently used item is evicted.
   * @param {any} key The key to add or update.
   * @param {any} value The value to associate with the key.
   */
  put(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);
    if (this.cache.size > this.capacity) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  /**
   * Clears the cache.
   */
  clear() {
    this.cache.clear();
  }
}

/**
 * Escapes regular expression special characters from a string by replacing them with their escaped counterparts.
 * @param {string} string The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Efficiently merge arrays, creating a new copy.
 * @param  {Array[]} arrs Arrays to merge.
 * @returns {Array} The merged array.
 */
function mergeArrays(...arrs) {
  return Array.prototype.concat.apply([], arrs);
}

// ============================================================================
// Top-level utilities from tokenizers.js
// ============================================================================

/**
 * Helper function to split a string on a regex, but keep the delimiters.
 * This is required, because the JavaScript `.split()` method does not keep the delimiters,
 * and wrapping in a capturing group causes issues with existing capturing groups (due to nesting).
 * @param {string} text The text to split.
 * @param {RegExp} regex The regex to split on.
 * @returns {string[]} The split string.
 */
function regexSplit(text, regex) {
  const result = [];
  let prev = 0;
  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0];
    if (prev < match.index) {
      result.push(text.slice(prev, match.index));
    }
    if (fullMatch.length > 0) {
      result.push(fullMatch);
    }
    prev = match.index + fullMatch.length;
  }
  if (prev < text.length) {
    result.push(text.slice(prev));
  }
  return result;
}

/**
 * Helper method to construct a pattern from a config object.
 * @param {Object} pattern The pattern object.
 * @param {boolean} invert Whether to invert the pattern.
 * @returns {RegExp|null} The compiled pattern.
 */
function createPattern(pattern, invert = true) {
  if (pattern.Regex !== undefined) {
    // In certain cases, the pattern may contain unnecessary escape sequences (e.g., \# or \& or \~).
    // i.e., valid in Python (where the patterns are exported from) but invalid in JavaScript (where the patterns are parsed).
    // This isn't an issue when creating the regex w/o the 'u' flag, but it is when the 'u' flag is used.
    // For this reason, it is necessary to remove these backslashes before creating the regex.
    // See https://stackoverflow.com/a/63007777/13989043 for more information
    let regex = pattern.Regex.replace(/\\([#&~])/g, "$1"); // TODO: add more characters to this list if necessary

    // We also handle special cases where the regex contains invalid (non-JS compatible) syntax.
    for (const [key, value] of PROBLEMATIC_REGEX_MAP) {
      regex = regex.replaceAll(key, value);
    }

    return new RegExp(regex, "gu");
  } else if (pattern.String !== undefined) {
    const escaped = escapeRegExp(pattern.String);
    // NOTE: if invert is true, we wrap the pattern in a group so that it is kept when performing .split()
    return new RegExp(invert ? escaped : `(${escaped})`, "gu");
  } else {
    console.warn("Unknown pattern type:", pattern);
    return null;
  }
}

/**
 * Helper function to convert an Object to a Map
 * @param {Object} obj The object to convert.
 * @returns {Map<string, any>} The map.
 */
function objectToMap(obj) {
  return new Map(Object.entries(obj));
}

/**
 * Helper function to fuse consecutive unknown tokens.
 * @param {string[]} arr The list of input tokens
 * @param {Map<string, any>} tokens_to_ids The mapping from tokens to token ids.
 * @param {number} unk_token_id The value to fuse on.
 * @private
 */
function fuse_unk(arr, tokens_to_ids, unk_token_id) {
  const fused = [];
  let i = 0;
  while (i < arr.length) {
    fused.push(arr[i]);
    if ((tokens_to_ids.get(arr[i]) ?? unk_token_id) !== unk_token_id) {
      ++i;
      continue;
    }

    while (
      ++i < arr.length &&
      (tokens_to_ids.get(arr[i]) ?? unk_token_id) === unk_token_id
    ) {
      if (tokens_to_ids.get(fused.at(-1)) !== unk_token_id) {
        fused[fused.length - 1] += arr[i];
      }
    }
  }

  return fused;
}

const BLOOM_SPLIT_CHARS = ".,!?…。，、।۔،";

// A mapping of regex patterns to their equivalent (but possibly longer) JS-compatible versions.
const PROBLEMATIC_REGEX_MAP = new Map([
  // This uses the case insensitive group modifier, which is not supported in JavaScript.
  // When parsing the regex, an "Invalid group" error is thrown.
  [
    "(?i:'s|'t|'re|'ve|'m|'ll|'d)",
    "(?:'([sS]|[tT]|[rR][eE]|[vV][eE]|[mM]|[lL][lL]|[dD]))",
  ],

  // Used to override the default (invalid) regex of the bloom pretokenizer.
  // For more information, see https://github.com/huggingface/transformers.js/issues/94
  [` ?[^(\\s|[${BLOOM_SPLIT_CHARS}])]+`, ` ?[^\\s${BLOOM_SPLIT_CHARS}]+`],
]);

/**
 * Returns list of utf-8 byte and a mapping to unicode strings.
 * Specifically avoids mapping to whitespace/control characters the BPE code barfs on.
 * @returns {Object} Object with utf-8 byte keys and unicode string values.
 */
const BYTES_TO_UNICODE = (() => {
  // Returns list of utf-8 byte and a mapping to unicode strings.
  // We specifically avoids mapping to whitespace/control characters
  // the bpe code barfs on.

  const bs = [
    ...Array.from(
      { length: "~".charCodeAt(0) - "!".charCodeAt(0) + 1 },
      (_, i) => i + "!".charCodeAt(0)
    ),
    ...Array.from(
      { length: "¬".charCodeAt(0) - "¡".charCodeAt(0) + 1 },
      (_, i) => i + "¡".charCodeAt(0)
    ),
    ...Array.from(
      { length: "ÿ".charCodeAt(0) - "®".charCodeAt(0) + 1 },
      (_, i) => i + "®".charCodeAt(0)
    ),
  ];
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; ++b) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const ccs = cs.map((n) => String.fromCharCode(n));
  return Object.fromEntries(bs.map((b, i) => [b, ccs[i]]));
})();

/**
 * Helper function for padding values of an object, which are each arrays.
 * NOTE: No additional checks are made here for validity of arguments.
 * @param {Record<string, any[]>} item The input object.
 * @param {number} length The length to pad to.
 * @param {(key: string) => any} value_fn Determine the value to fill the array, based on its key.
 * @param {string} side Which side to pad the array.
 * @private
 */
function padHelper(item, length, value_fn, side) {
  for (const key of Object.keys(item)) {
    const diff = length - item[key].length;
    const value = value_fn(key);

    const padData = new Array(diff).fill(value);
    item[key] =
      side === "right"
        ? mergeArrays(item[key], padData)
        : mergeArrays(padData, item[key]);
  }
}

/**
 * Helper function for truncating values of an object, which are each arrays.
 * NOTE: No additional checks are made here for validity of arguments.
 * @param {Record<string, any[]>} item The input object.
 * @param {number} length The length to truncate to.
 * @private
 */
function truncateHelper(item, length) {
  // Setting .length to a lower value truncates the array in-place:
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/length
  for (const key of Object.keys(item)) {
    item[key].length = length;
  }
}

// ============================================================================
// AddedToken
// ============================================================================

/**
 * Represent a token added by the user on top of the existing Model vocabulary.
 * AddedToken can be configured to specify the behavior they should have in various situations like:
 *   - Whether they should only match single words
 *   - Whether to include any whitespace on its left or right
 */
class AddedToken {
  /**
   * Creates a new instance of AddedToken.
   * @param {Object} config Added token configuration object.
   * @param {string} config.content The content of the added token.
   * @param {number} config.id The id of the added token.
   * @param {boolean} [config.single_word=false] Whether this token must be a single word or can break words.
   * @param {boolean} [config.lstrip=false] Whether this token should strip whitespaces on its left.
   * @param {boolean} [config.rstrip=false] Whether this token should strip whitespaces on its right.
   * @param {boolean} [config.normalized=false] Whether this token should be normalized.
   * @param {boolean} [config.special=false] Whether this token is special.
   */
  constructor(config) {
    this.content = config.content;
    this.id = config.id;
    this.single_word = config.single_word ?? false;
    this.lstrip = config.lstrip ?? false;
    this.rstrip = config.rstrip ?? false;
    this.special = config.special ?? false;
    this.normalized = config.normalized ?? null;
  }
}

// ============================================================================
// TokenizerModel (base) — fromConfig pruned to BPE only
// ============================================================================

/**
 * Abstract base class for tokenizer models.
 * @extends Callable
 */
class TokenizerModel extends Callable {
  /**
   * Creates a new instance of TokenizerModel.
   * @param {Object} config The configuration object for the TokenizerModel.
   */
  constructor(config) {
    super();
    this.config = config;

    /** @type {string[]} */
    this.vocab = [];

    /**
     * A mapping of tokens to ids.
     * @type {Map<string, number>}
     */
    this.tokens_to_ids = new Map();

    this.unk_token_id = undefined;
    this.unk_token = undefined;
    this.end_of_word_suffix = undefined;

    /** @type {boolean} Whether to fuse unknown tokens when encoding. Defaults to false. */
    this.fuse_unk = this.config.fuse_unk ?? false;
  }

  /**
   * Instantiates a new TokenizerModel instance based on the configuration object provided.
   * @param {Object} config The configuration object for the TokenizerModel.
   * @param {...*} args Optional arguments to pass to the specific TokenizerModel constructor.
   * @returns {TokenizerModel} A new instance of a TokenizerModel.
   * @throws Will throw an error if the TokenizerModel type in the config is not recognized.
   */
  static fromConfig(config, ...args) {
    switch (config.type) {
      case "BPE":
        return new BPE(config);

      default:
        if (config.vocab && !Array.isArray(config.vocab)) {
          if (
            Object.hasOwn(config, "continuing_subword_prefix") &&
            Object.hasOwn(config, "unk_token") &&
            Object.hasOwn(config, "merges")
          ) {
            return new BPE(config);
          }
        }
        throw new Error(`Unknown TokenizerModel type: ${config.type}`);
    }
  }

  /**
   * Internal function to call the TokenizerModel instance.
   * @param {string[]} tokens The tokens to encode.
   * @returns {string[]} The encoded tokens.
   */
  _call(tokens) {
    tokens = this.encode(tokens);
    if (this.fuse_unk) {
      // Fuse unknown tokens
      tokens = fuse_unk(tokens, this.tokens_to_ids, this.unk_token_id);
    }
    return tokens;
  }

  /**
   * Encodes a list of tokens into a list of token IDs.
   * @param {string[]} tokens The tokens to encode.
   * @returns {string[]} The encoded tokens.
   * @throws Will throw an error if not implemented in a subclass.
   */
  encode(tokens) {
    throw Error("encode should be implemented in subclass.");
  }

  /**
   * Converts a list of tokens into a list of token IDs.
   * @param {string[]} tokens The tokens to convert.
   * @returns {number[]} The converted token IDs.
   */
  convert_tokens_to_ids(tokens) {
    return tokens.map((t) => this.tokens_to_ids.get(t) ?? this.unk_token_id);
  }

  /**
   * Converts a list of token IDs into a list of tokens.
   * @param {number[]|bigint[]} ids The token IDs to convert.
   * @returns {string[]} The converted tokens.
   */
  convert_ids_to_tokens(ids) {
    return ids.map((i) => this.vocab[i] ?? this.unk_token);
  }
}

// ============================================================================
// BPE model
// ============================================================================

/**
 * @typedef {Object} BPENode
 * @property {string} token The token associated with the node
 * @property {number} bias A positional bias for the node.
 * @property {number} [score] The score of the node.
 * @property {BPENode} [prev] The previous node in the linked list.
 * @property {BPENode} [next] The next node in the linked list.
 */

/**
 * BPE class for encoding text into Byte-Pair-Encoding (BPE) tokens.
 * @extends TokenizerModel
 */
class BPE extends TokenizerModel {
  /**
   * Create a BPE instance.
   * @param {Object} config The configuration object for BPE.
   * @param {Object} config.vocab A mapping of tokens to ids.
   * @param {string[]|[string, string][]} config.merges An array of BPE merges as strings.
   * @param {string} config.unk_token The unknown token used for out of vocabulary words.
   * @param {string} config.end_of_word_suffix The suffix to place at the end of each word.
   * @param {string} [config.continuing_subword_suffix] The suffix to insert between words.
   * @param {boolean} [config.byte_fallback=false] Whether to use spm byte-fallback trick (defaults to False)
   * @param {boolean} [config.ignore_merges=false] Whether or not to match tokens with the vocab before using merges.
   */
  constructor(config) {
    super(config);

    /** @type {Map<string, number>} */
    this.tokens_to_ids = objectToMap(config.vocab);

    this.unk_token_id = this.tokens_to_ids.get(config.unk_token);
    this.unk_token = config.unk_token;

    this.vocab = new Array(this.tokens_to_ids.size);
    for (const [key, value] of this.tokens_to_ids) {
      this.vocab[value] = key;
    }

    // Tokenizers >= 0.20.0 serializes BPE merges as a [string, string][] instead of a string[],
    // which resolves the ambiguity for merges containing spaces.
    const use_new_merge_format = Array.isArray(config.merges[0]);

    /** @type {[string, string][]} */
    this.merges = use_new_merge_format
      ? /** @type {[string, string][]} */ (config.merges)
      : /** @type {string[]} */ (config.merges).map(
          (x) => /** @type {[string, string]} */ (x.split(" ", 2))
        );
    this.bpe_ranks = new Map(this.merges.map((x, i) => [JSON.stringify(x), i]));

    this.end_of_word_suffix = config.end_of_word_suffix;

    // NOTE: `continuing_subword_suffix` is custom (to support `BlenderbotSmallTokenizer`)
    this.continuing_subword_suffix = config.continuing_subword_suffix ?? null;

    this.byte_fallback = this.config.byte_fallback ?? false;

    if (this.byte_fallback) {
      this.text_encoder = new TextEncoder();
    }

    this.ignore_merges = this.config.ignore_merges ?? false;

    /**
     * The maximum length we should cache in a model.
     * Strings that are too long have minimal chances to cache hit anyway
     */
    this.max_length_to_cache = 256;

    /**
     * The default capacity for a `BPE`'s internal cache.
     */
    this.cache_capacity = 10000;
    this.cache = new LRUCache(this.cache_capacity);
  }

  /**
   * Clears the cache.
   */
  clear_cache() {
    this.cache.clear();
  }

  /**
   * Apply Byte-Pair-Encoding (BPE) to a given token. Efficient heap-based priority
   * queue implementation adapted from https://github.com/belladoreai/llama-tokenizer-js.
   * @param {string} token The token to encode.
   * @returns {string[]} The BPE encoded tokens.
   */
  bpe(token) {
    if (token.length === 0) {
      return [];
    }

    const cached = this.cache.get(token);
    if (cached !== undefined) {
      return cached;
    }

    const word = Array.from(token);
    if (this.end_of_word_suffix) {
      word[word.length - 1] += this.end_of_word_suffix;
    }

    let result = [];
    if (word.length > 1) {
      // Create a priority queue to store the nodes that will be merged.
      // The comparator function compares the scores of the nodes.
      const queue = new PriorityQueue((a, b) => a.score < b.score);

      // Construct a doubly-linked list of nodes that will be inserted into the priority queue,
      // starting with the individual characters. We also populate each node with a positional
      // bias to break ties in the priority queue.
      let startingNode = {
        token: word[0],
        bias: 0,
        prev: null,
        next: null,
      };

      let previousNode = startingNode;
      for (let i = 1; i < word.length; ++i) {
        const currentNode = {
          bias: i / word.length, // Add fractional component to break ties
          token: word[i],
          prev: previousNode,
          next: null,
        };
        previousNode.next = currentNode;
        this._add_node(queue, previousNode);
        previousNode = currentNode;
      }

      while (!queue.isEmpty()) {
        // Get the next node with the highest priority
        const node = queue.pop();

        // Check that this merge is still possible
        if (node.deleted || !node.next || node.next.deleted) continue;

        // Here, we mark the current node (left side of the merge) and the next node (right side of the merge) as deleted.
        // This is because they will both be replaced by a new node representing the merge result.
        node.deleted = true;
        node.next.deleted = true;

        // Next, we fix the node that comes before the current node (i.e., left side of the merge).
        if (node.prev) {
          // Make a shallow copy of the previous node
          const newPreviousNode = { ...node.prev };

          // Mark the old previous node as deleted. This avoids erroneous merges later,
          // because there may still be references to this node in the priority queue.
          node.prev.deleted = true;
          node.prev = newPreviousNode;

          // Update the reference of the previous node, by pointing its previous node to this new previous node.
          if (newPreviousNode.prev) {
            newPreviousNode.prev.next = newPreviousNode;
          } else {
            // If the previous of the previous node does not exist, it means that
            // `newPreviousNode` must be the new `startingNode`.
            startingNode = newPreviousNode;
          }
        }

        // Create a new node which represents the result of the merge.
        const merged = {
          token: node.token + node.next.token,
          bias: node.bias,
          prev: node.prev,
          next: node.next.next,
        };

        // We now consider where we can add the new merged node to the priority queue:
        // 1. prev <-> merged
        if (merged.prev) {
          merged.prev.next = merged;
          this._add_node(queue, merged.prev);
        } else {
          // If `merged.prev` does not exist, then `merged` must be the new `startingNode`.
          startingNode = merged;
        }

        // 2. merged <-> next
        if (merged.next) {
          merged.next.prev = merged;
          this._add_node(queue, merged);
        }
      }

      // Traverse the linked list, starting from the `startingNode`, and collect the tokens.
      for (
        let currentNode = startingNode;
        currentNode !== null;
        currentNode = currentNode.next
      ) {
        result.push(currentNode.token);
      }
    } else {
      result = word;
    }

    // Possibly append suffix
    if (this.continuing_subword_suffix) {
      // Do not append suffix to the last token
      for (let i = 0; i < result.length - 1; ++i) {
        result[i] += this.continuing_subword_suffix;
      }
    }

    if (token.length < this.max_length_to_cache) {
      // Save the result to the cache
      this.cache.put(token, result);
    }

    return result;
  }

  /**
   * Helper function to add a node to the priority queue.
   * @param {PriorityQueue} queue
   * @param {BPENode} node
   * @private
   */
  _add_node(queue, node) {
    // `score` is a measure of the merge priority: lower means higher priority
    // We use the BPE rank as a measure of priority (i.e., the local of the merge in the merges list)
    // We also add a fractional component to the score to break ties (with the earlier character having higher priority)
    const rank = this.bpe_ranks.get(
      JSON.stringify([node.token, node.next.token])
    );
    if (rank !== undefined) {
      node.score = rank + node.bias;
      queue.push(node);
    }
  }

  /**
   * Encodes the input sequence of tokens using the BPE algorithm and returns the resulting subword tokens.
   * @param {string[]} tokens The input sequence of tokens to encode.
   * @returns {string[]} The resulting subword tokens after applying the BPE algorithm to the input sequence of tokens.
   */
  encode(tokens) {
    const outputTokens = [];

    for (const token of tokens) {
      if (this.ignore_merges && this.tokens_to_ids.has(token)) {
        outputTokens.push(token);
        continue;
      }
      const bpe_token_list = this.bpe(token);

      for (const t of bpe_token_list) {
        if (this.tokens_to_ids.has(t)) {
          outputTokens.push(t);
        } else if (this.byte_fallback) {
          const byteTokens = Array.from(this.text_encoder.encode(t)).map(
            (x) => `<0x${x.toString(16).toUpperCase().padStart(2, "0")}>`
          );
          if (byteTokens.every((x) => this.tokens_to_ids.has(x))) {
            // Ensure the byte tokens are actually in the vocabulary, otherwise
            // we fall back to the unknown token. For more information, see
            // https://github.com/huggingface/transformers/issues/28096.
            outputTokens.push(...byteTokens);
          } else {
            outputTokens.push(this.unk_token);
          }
        } else {
          outputTokens.push(this.unk_token);
        }
      }
    }

    return outputTokens;
  }
}

// ============================================================================
// Normalizer (base + NFC, NFKC, Replace, Sequence)
// ============================================================================

/**
 * A base class for text normalization.
 * @abstract
 */
class Normalizer extends Callable {
  /**
   * @param {Object} config The configuration object for the normalizer.
   */
  constructor(config) {
    super();
    this.config = config;
  }

  /**
   * Factory method for creating normalizers from config objects.
   * @static
   * @param {Object} config The configuration object for the normalizer.
   * @returns {Normalizer} A Normalizer object.
   */
  static fromConfig(config) {
    if (config === null) return null;
    switch (config.type) {
      case "Sequence":
        return new NormalizerSequence(config);
      case "Replace":
        return new Replace(config);
      case "NFC":
        return new NFC(config);
      case "NFKC":
        return new NFKC(config);
      default:
        console.warn(`Unknown Normalizer type: ${config.type}, returning null`);
        return null;
    }
  }

  /**
   * Normalize the input text.
   * @abstract
   * @param {string} text The text to normalize.
   * @returns {string} The normalized text.
   * @throws {Error} If this method is not implemented in a subclass.
   */
  normalize(text) {
    throw Error("normalize should be implemented in subclass.");
  }

  /**
   * Alias for {@link Normalizer#normalize}.
   * @param {string} text The text to normalize.
   * @returns {string} The normalized text.
   */
  _call(text) {
    return this.normalize(text);
  }
}

/**
 * Replace normalizer that replaces occurrences of a pattern with a given string or regular expression.
 * @extends Normalizer
 */
class Replace extends Normalizer {
  /**
   * Normalize the input text by replacing the pattern with the content.
   * @param {string} text The input text to be normalized.
   * @returns {string} The normalized text after replacing the pattern with the content.
   */
  normalize(text) {
    const pattern = createPattern(this.config.pattern);
    return pattern === null
      ? text
      : text.replaceAll(pattern, this.config.content);
  }
}

/**
 * A normalizer that applies Unicode normalization to the input text.
 * @extends Normalizer
 * @abstract
 */
class UnicodeNormalizer extends Normalizer {
  /**
   * @type {string} The Unicode normalization form to apply.
   * Should be one of: 'NFC', 'NFD', 'NFKC', or 'NFKD'.
   */
  form = undefined;

  /**
   * Normalize the input text by applying Unicode normalization.
   * @param {string} text The input text to be normalized.
   * @returns {string} The normalized text.
   */
  normalize(text) {
    text = text.normalize(this.form);
    return text;
  }
}

/**
 * A normalizer that applies Unicode normalization form C (NFC) to the input text.
 * Canonical Decomposition, followed by Canonical Composition.
 * @extends UnicodeNormalizer
 */
class NFC extends UnicodeNormalizer {
  form = "NFC";
}

/**
 * A normalizer that applies Unicode normalization form KC (NFKC) to the input text.
 * Compatibility Decomposition, followed by Canonical Composition.
 * @extends UnicodeNormalizer
 */
class NFKC extends UnicodeNormalizer {
  form = "NFKC";
}

/**
 * A Normalizer that applies a sequence of Normalizers.
 * @extends Normalizer
 */
class NormalizerSequence extends Normalizer {
  /**
   * Create a new instance of NormalizerSequence.
   * @param {Object} config The configuration object.
   * @param {Object[]} config.normalizers An array of Normalizer configuration objects.
   */
  constructor(config) {
    super(config);
    this.normalizers = config.normalizers.map((x) => Normalizer.fromConfig(x));
  }
  /**
   * Apply a sequence of Normalizers to the input text.
   * @param {string} text The text to normalize.
   * @returns {string} The normalized text.
   */
  normalize(text) {
    return this.normalizers.reduce((t, normalizer) => {
      return normalizer ? normalizer.normalize(t) : t;
    }, text);
  }
}

// ============================================================================
// PreTokenizer (base + ByteLevel, Split, Digits, Sequence)
// ============================================================================

/**
 * A callable class representing a pre-tokenizer used in tokenization. Subclasses
 * should implement the `pre_tokenize_text` method to define the specific pre-tokenization logic.
 * @extends Callable
 */
class PreTokenizer extends Callable {
  /**
   * Factory method that returns an instance of a subclass of `PreTokenizer` based on the provided configuration.
   *
   * @static
   * @param {Object} config A configuration object for the pre-tokenizer.
   * @returns {PreTokenizer} An instance of a subclass of `PreTokenizer`.
   */
  static fromConfig(config) {
    if (config === null) return null;

    switch (config.type) {
      case "Sequence":
        return new PreTokenizerSequence(config);
      case "ByteLevel":
        return new ByteLevelPreTokenizer(config);
      case "Split":
        return new SplitPreTokenizer(config);
      case "Digits":
        return new DigitsPreTokenizer(config);
      default:
        console.warn(`Unknown PreTokenizer type: ${config.type}, returning null`);
        return null;
    }
  }

  /**
   * Method that should be implemented by subclasses to define the specific pre-tokenization logic.
   *
   * @abstract
   * @param {string} text The text to pre-tokenize.
   * @param {Object} [options] Additional options for the pre-tokenization logic.
   * @returns {string[]} The pre-tokenized text.
   * @throws {Error} If the method is not implemented in the subclass.
   */
  pre_tokenize_text(text, options) {
    throw Error("pre_tokenize_text should be implemented in subclass.");
  }

  /**
   * Tokenizes the given text into pre-tokens.
   * @param {string|string[]} text The text or array of texts to pre-tokenize.
   * @param {Object} [options] Additional options for the pre-tokenization logic.
   * @returns {string[]} An array of pre-tokens.
   */
  pre_tokenize(text, options) {
    return (
      Array.isArray(text)
        ? text.map((x) => this.pre_tokenize_text(x, options))
        : this.pre_tokenize_text(text, options)
    ).flat();
  }

  /**
   * Alias for {@link PreTokenizer#pre_tokenize}.
   * @param {string|string[]} text The text or array of texts to pre-tokenize.
   * @param {Object} [options] Additional options for the pre-tokenization logic.
   * @returns {string[]} An array of pre-tokens.
   */
  _call(text, options) {
    return this.pre_tokenize(text, options);
  }
}

/**
 * A pre-tokenizer that splits text into Byte-Pair-Encoding (BPE) subwords.
 * @extends PreTokenizer
 */
class ByteLevelPreTokenizer extends PreTokenizer {
  /**
   * Creates a new instance of the `ByteLevelPreTokenizer` class.
   * @param {Object} config The configuration object.
   */
  constructor(config) {
    super();
    this.config = config;

    /**
     * @type {boolean} Whether to add a leading space to the first word.
     * This allows to treat the leading word just as any other word.
     */
    this.add_prefix_space = this.config.add_prefix_space;

    /**
     * @type {boolean} Whether the post processing step should trim offsets
     * to avoid including whitespaces.
     * @todo Use this in the pretokenization step.
     */
    this.trim_offsets = this.config.trim_offsets;

    /**
     * @type {boolean} Whether to use the standard GPT2 regex for whitespace splitting.
     * Set it to False if you want to use your own splitting. Defaults to true.
     */
    this.use_regex = this.config.use_regex ?? true;
    this.pattern =
      /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

    this.byte_encoder = BYTES_TO_UNICODE;
    this.text_encoder = new TextEncoder();
  }

  /**
   * Tokenizes a single piece of text using byte-level tokenization.
   * @param {string} text The text to tokenize.
   * @param {Object} [options] Additional options for the pre-tokenization logic.
   * @returns {string[]} An array of tokens.
   */
  pre_tokenize_text(text, options) {
    // Add a leading space if the option is enabled
    if (this.add_prefix_space && !text.startsWith(" ")) {
      text = " " + text;
    }

    // Split on whitespace and punctuation
    const tokens = this.use_regex ? text.match(this.pattern) || [] : [text];

    // Maps all our bytes to unicode strings, avoiding control tokens of the BPE (spaces in our case)
    return tokens.map((token) =>
      Array.from(
        this.text_encoder.encode(token),
        (byte) => this.byte_encoder[byte]
      ).join("")
    );
  }
}

/**
 * @typedef {'removed'|'isolated'|'mergedWithPrevious'|'mergedWithNext'|'contiguous'} SplitDelimiterBehavior
 */

/**
 * Splits text using a given pattern.
 * @extends PreTokenizer
 */
class SplitPreTokenizer extends PreTokenizer {
  /**
   * @param {Object} config The configuration options for the pre-tokenizer.
   * @param {Object} config.pattern The pattern used to split the text. Can be a string or a regex object.
   * @param {string|undefined} config.pattern.String The string to use for splitting. Only defined if the pattern is a string.
   * @param {string|undefined} config.pattern.Regex The regex to use for splitting. Only defined if the pattern is a regex.
   * @param {SplitDelimiterBehavior} config.behavior The behavior to use when splitting.
   * @param {boolean} config.invert Whether to split (invert=false) or match (invert=true) the pattern.
   */
  constructor(config) {
    super();
    this.config = config;
    // TODO support all behaviours (config.behavior)

    this.pattern = createPattern(this.config.pattern, this.config.invert);
  }

  /**
   * Tokenizes text by splitting it using the given pattern.
   * @param {string} text The text to tokenize.
   * @param {Object} [options] Additional options for the pre-tokenization logic.
   * @returns {string[]} An array of tokens.
   */
  pre_tokenize_text(text, options) {
    if (this.pattern === null) {
      return [];
    }

    if (this.config.invert) {
      return text.match(this.pattern) || [];
    } else if (this.config.behavior?.toLowerCase() === "removed") {
      return text.split(this.pattern).filter((x) => x);
    } else {
      return regexSplit(text, this.pattern);
    }
  }
}

/**
 * Splits text based on digits.
 * @extends PreTokenizer
 */
class DigitsPreTokenizer extends PreTokenizer {
  /**
   * @param {Object} config The configuration options for the pre-tokenizer.
   * @param {boolean} config.individual_digits Whether to split on individual digits.
   */
  constructor(config) {
    super();
    this.config = config;

    // Construct a pattern which matches the rust implementation:
    const digit_pattern = `[^\\d]+|\\d${
      this.config.individual_digits ? "" : "+"
    }`;
    this.pattern = new RegExp(digit_pattern, "gu");
  }

  /**
   * Tokenizes text by splitting it using the given pattern.
   * @param {string} text The text to tokenize.
   * @param {Object} [options] Additional options for the pre-tokenization logic.
   * @returns {string[]} An array of tokens.
   */
  pre_tokenize_text(text, options) {
    return text.match(this.pattern) || [];
  }
}

/**
 * A pre-tokenizer that applies a sequence of pre-tokenizers to the input text.
 * @extends PreTokenizer
 */
class PreTokenizerSequence extends PreTokenizer {
  /**
   * Creates an instance of PreTokenizerSequence.
   * @param {Object} config The configuration object for the pre-tokenizer sequence.
   * @param {Object[]} config.pretokenizers An array of pre-tokenizer configurations.
   */
  constructor(config) {
    super();
    this.tokenizers = config.pretokenizers.map((x) =>
      PreTokenizer.fromConfig(x)
    );
  }

  /**
   * Applies each pre-tokenizer in the sequence to the input text in turn.
   * @param {string} text The text to pre-tokenize.
   * @param {Object} [options] Additional options for the pre-tokenization logic.
   * @returns {string[]} The pre-tokenized text.
   */
  pre_tokenize_text(text, options) {
    // Use reduce to apply each tokenizer to the text
    return this.tokenizers.reduce(
      (preTokenizedText, tokenizer) => {
        return tokenizer ? tokenizer.pre_tokenize(preTokenizedText, options) : preTokenizedText;
      },
      [text]
    );
  }
}

// ============================================================================
// PostProcessor
// ============================================================================

class PostProcessor extends Callable {
  constructor(config) {
    super();
    this.config = config;
  }

  static fromConfig(config) {
    if (config === null) return null;
    switch (config.type) {
      case 'TemplateProcessing':
        return new TemplateProcessing(config);
      case 'ByteLevel':
        return new ByteLevelPostProcessor(config);
      case 'Sequence':
        return new PostProcessorSequence(config);
      default:
        return null;
    }
  }

  post_process(tokens, ...args) {
    throw Error('post_process should be implemented in subclass.');
  }

  _call(tokens, ...args) {
    return this.post_process(tokens, ...args);
  }
}

class TemplateProcessing extends PostProcessor {
  constructor(config) {
    super(config);
    this.single = config.single;
    this.pair = config.pair;
  }

  post_process(tokens, tokens_pair = null, { add_special_tokens = true } = {}) {
    const type = tokens_pair === null ? this.single : this.pair;
    let processedTokens = [];
    let types = [];
    for (const item of type) {
      if ('SpecialToken' in item) {
        if (add_special_tokens) {
          processedTokens.push(item.SpecialToken.id);
          types.push(item.SpecialToken.type_id);
        }
      } else if ('Sequence' in item) {
        if (item.Sequence.id === 'A') {
          processedTokens = mergeArrays(processedTokens, tokens);
          types = mergeArrays(types, new Array(tokens.length).fill(item.Sequence.type_id));
        } else if (item.Sequence.id === 'B') {
          processedTokens = mergeArrays(processedTokens, tokens_pair);
          types = mergeArrays(types, new Array(tokens_pair.length).fill(item.Sequence.type_id));
        }
      }
    }
    return { tokens: processedTokens, token_type_ids: types };
  }
}

class ByteLevelPostProcessor extends PostProcessor {
  post_process(tokens, tokens_pair = null) {
    if (tokens_pair) {
      tokens = mergeArrays(tokens, tokens_pair);
    }
    return { tokens };
  }
}

class PostProcessorSequence extends PostProcessor {
  constructor(config) {
    super(config);
    this.processors = config.processors.map((x) => PostProcessor.fromConfig(x));
  }

  post_process(tokens, tokens_pair = null, options = {}) {
    let token_type_ids;
    for (const processor of this.processors) {
      if (processor instanceof ByteLevelPostProcessor) {
        const output = processor.post_process(tokens);
        tokens = output.tokens;
        if (tokens_pair) {
          const pair_output = processor.post_process(tokens_pair);
          tokens_pair = pair_output.tokens;
        }
      } else {
        const output = processor.post_process(tokens, tokens_pair, options);
        tokens = output.tokens;
        token_type_ids = output.token_type_ids;
      }
    }
    return { tokens, token_type_ids };
  }
}

// ============================================================================
// Decoder — stub (encode-only, we don't need decoding)
// ============================================================================

/**
 * The base class for token decoders.
 * @extends Callable
 */
class Decoder extends Callable {
  /**
   * Creates an instance of `Decoder`.
   *
   * @param {Object} config The configuration object.
   */
  constructor(config) {
    super();
    this.config = config;

    /** @type {AddedToken[]} */
    this.added_tokens = [];
    this.end_of_word_suffix = null;
    this.trim_offsets = config.trim_offsets;
  }

  /**
   * Creates a decoder instance based on the provided configuration.
   * For encode-only use we return null for all types.
   *
   * @param {Object} config The configuration object.
   * @returns {Decoder|null} A decoder instance, or null.
   */
  static fromConfig(config) {
    if (config === null) return null;
    // Encode-only engine does not need decoders.
    return null;
  }

  /**
   * Calls the `decode` method.
   *
   * @param {string[]} tokens The list of tokens.
   * @returns {string} The decoded string.
   */
  _call(tokens) {
    return this.decode(tokens);
  }

  /**
   * Decodes a list of tokens.
   * @param {string[]} tokens The list of tokens.
   * @returns {string} The decoded string.
   */
  decode(tokens) {
    return this.decode_chain(tokens).join("");
  }

  /**
   * Apply the decoder to a list of tokens.
   *
   * @param {string[]} tokens The list of tokens.
   * @returns {string[]} The decoded list of tokens.
   */
  decode_chain(tokens) {
    throw Error("`decode_chain` should be implemented in subclass.");
  }
}

// ============================================================================
// PreTrainedTokenizer (trimmed for encode-only)
// ============================================================================

/**
 * @typedef {Object} EncodingSingle
 * @property {number[]} input_ids List of token ids to be fed to a model.
 * @property {number[]} attention_mask List of token type ids to be fed to a model
 * @property {number[]} [token_type_ids] List of indices specifying which tokens should be attended to by the model
 */

/**
 * @typedef {Object} BatchEncoding Holds the output of the tokenizer's call function.
 * @property {number[]|number[][]} input_ids List of token ids to be fed to a model.
 * @property {number[]|number[][]} attention_mask List of indices specifying which tokens should be attended to by the model.
 * @property {number[]|number[][]} [token_type_ids] List of token type ids to be fed to a model.
 */

class PreTrainedTokenizer extends Callable {
  return_token_type_ids = false;

  padding_side = "right";
  /**
   * Create a new PreTrainedTokenizer instance.
   * @param {Object} tokenizerJSON The JSON of the tokenizer.
   * @param {Object} tokenizerConfig The config of the tokenizer.
   */
  constructor(tokenizerJSON, tokenizerConfig) {
    super();

    this.config = tokenizerConfig;

    // Construct parts of the tokenizer from the JSON
    /**
     * @type {Normalizer | null}
     */
    this.normalizer = Normalizer.fromConfig(tokenizerJSON.normalizer);
    this.pre_tokenizer = PreTokenizer.fromConfig(tokenizerJSON.pre_tokenizer);
    this.model = TokenizerModel.fromConfig(
      tokenizerJSON.model,
      tokenizerConfig
    );
    this.post_processor = PostProcessor.fromConfig(
      tokenizerJSON.post_processor
    );
    this.decoder = Decoder.fromConfig(tokenizerJSON.decoder);

    // Add added_tokens to model
    this.special_tokens = [];
    this.all_special_ids = [];

    /** @type {AddedToken[]} */
    this.added_tokens = [];
    for (const addedToken of tokenizerJSON.added_tokens) {
      const token = new AddedToken(addedToken);
      this.added_tokens.push(token);

      this.model.tokens_to_ids.set(token.content, token.id);
      this.model.vocab[token.id] = token.content;

      if (token.special) {
        this.special_tokens.push(token.content);
        this.all_special_ids.push(token.id);
      }
    }

    // Update additional_special_tokens
    this.additional_special_tokens =
      tokenizerConfig.additional_special_tokens ?? [];
    this.special_tokens.push(...this.additional_special_tokens);
    this.special_tokens = [...new Set(this.special_tokens)]; // Remove duplicates

    if (this.decoder) {
      // Slight hack, but it prevents code duplication:
      this.decoder.added_tokens = this.added_tokens;

      // Another slight hack to add `end_of_word_suffix` (if present) to the decoder
      // This is needed for cases where BPE model and ByteLevel decoder are used
      // For more information, see https://github.com/huggingface/transformers.js/issues/74
      this.decoder.end_of_word_suffix = this.model.end_of_word_suffix;
    }

    this.added_tokens_splitter = new DictionarySplitter(
      this.added_tokens.map((x) => x.content)
    );

    /** @type {Map<string, AddedToken>} */
    this.added_tokens_map = new Map(
      this.added_tokens.map((x) => [x.content, x])
    );

    // Set mask token if present (otherwise will be undefined, which is fine)
    this.mask_token = this.getToken("mask_token");
    this.mask_token_id = this.model.tokens_to_ids.get(this.mask_token);

    this.pad_token = this.getToken("pad_token", "eos_token");
    this.pad_token_id = this.model.tokens_to_ids.get(this.pad_token);

    this.sep_token = this.getToken("sep_token");
    this.sep_token_id = this.model.tokens_to_ids.get(this.sep_token);

    this.unk_token = this.getToken("unk_token");
    this.unk_token_id = this.model.tokens_to_ids.get(this.unk_token);

    this.bos_token = this.getToken("bos_token");
    this.bos_token_id = this.model.tokens_to_ids.get(this.bos_token);

    this.eos_token = this.getToken("eos_token");
    this.eos_token_id = this.model.tokens_to_ids.get(this.eos_token);

    this.model_max_length = tokenizerConfig.model_max_length;

    /** @type {boolean} Whether or not to strip the text when tokenizing (removing excess spaces before and after the string). */
    this.remove_space = tokenizerConfig.remove_space;

    this.clean_up_tokenization_spaces =
      tokenizerConfig.clean_up_tokenization_spaces ?? true;
    this.do_lowercase_and_remove_accent =
      tokenizerConfig.do_lowercase_and_remove_accent ?? false;

    if (tokenizerConfig.padding_side) {
      this.padding_side = tokenizerConfig.padding_side;
    }

    this.add_bos_token = tokenizerConfig.add_bos_token;
    this.add_eos_token = tokenizerConfig.add_eos_token;

    this.legacy = false;
  }

  /**
   * Returns the value of the first matching key in the tokenizer config object.
   * @param {...string} keys One or more keys to search for in the tokenizer config object.
   * @returns {string|null} The value associated with the first matching key, or null if no match is found.
   * @throws {Error} If an object is found for a matching key and its __type property is not "AddedToken".
   * @private
   */
  getToken(...keys) {
    for (const key of keys) {
      const item = this.config[key];

      if (!item) continue;

      if (typeof item === "object") {
        if (item.__type === "AddedToken") {
          return item.content;
        } else {
          throw Error(`Unknown token: ${item}`);
        }
      } else {
        return item;
      }
    }
    return null;
  }

  /**
   * Encode/tokenize the given text(s).
   * @param {string|string[]} text The text to tokenize.
   * @param {Object} options An optional object containing the following properties:
   * @param {string|string[]} [options.text_pair=null] Optional second sequence to be encoded. If set, must be the same type as text.
   * @param {boolean|'max_length'} [options.padding=false] Whether to pad the input sequences.
   * @param {boolean} [options.add_special_tokens=true] Whether or not to add the special tokens associated with the corresponding model.
   * @param {boolean} [options.truncation=null] Whether to truncate the input sequences.
   * @param {number} [options.max_length=null] Maximum length of the returned list and optionally padding length.
   * @param {boolean} [options.return_token_type_ids=null] Whether to return the token type ids.
   * @returns {BatchEncoding} Object to be passed to the model.
   */
  _call(
    // Required positional arguments
    text,

    // Optional keyword arguments
    {
      text_pair = null,
      add_special_tokens = true,
      padding = false,
      truncation = null,
      max_length = null,
      return_token_type_ids = null,
    } = {}
  ) {
    const isBatched = Array.isArray(text);

    /** @type {EncodingSingle[]} */
    let encodedTokens;

    if (isBatched) {
      if (text.length === 0) {
        throw Error("text array must be non-empty");
      }

      if (text_pair !== null) {
        if (!Array.isArray(text_pair)) {
          throw Error("text_pair must also be an array");
        } else if (text.length !== text_pair.length) {
          throw Error("text and text_pair must have the same length");
        }

        encodedTokens = text.map((t, i) =>
          this._encode_plus(t, {
            text_pair: text_pair[i],
            add_special_tokens,
            return_token_type_ids,
          })
        );
      } else {
        encodedTokens = text.map((x) =>
          this._encode_plus(x, { add_special_tokens, return_token_type_ids })
        );
      }
    } else {
      if (text === null || text === undefined) {
        throw Error("text may not be null or undefined");
      }

      if (Array.isArray(text_pair)) {
        throw Error(
          "When specifying `text_pair`, since `text` is a string, `text_pair` must also be a string (i.e., not an array)."
        );
      }

      // For single input, we just wrap in an array, and then unwrap later.
      encodedTokens = [
        this._encode_plus(text, {
          text_pair,
          add_special_tokens,
          return_token_type_ids,
        }),
      ];
    }
    // At this point, `encodedTokens` is batched, of shape [batch_size, tokens].
    // However, array may be jagged. So, we may need pad to max_length.
    if (max_length === null) {
      max_length = this.model_max_length;
    } else if (truncation === null) {
      if (padding === true) {
        console.warn(
          "`max_length` is ignored when `padding: true` and there is no truncation strategy. " +
            "To pad to max length, use `padding: 'max_length'`."
        );
        max_length = this.model_max_length;
      } else if (padding === false) {
        console.warn(
          "Truncation was not explicitly activated but `max_length` is provided a specific value, please use `truncation: true` to explicitly truncate examples to max length."
        );
        truncation = true;
      }
    }

    // padding: 'max_length' doesn't require any additional calculation
    // but padding: true has to calculate max_length from the sequences
    if (padding === true) {
      // Inline max: find the longest input_ids length
      let maxLen = 0;
      for (const enc of encodedTokens) {
        if (enc.input_ids.length > maxLen) maxLen = enc.input_ids.length;
      }
      max_length = Math.min(maxLen, max_length ?? Infinity);
    }

    // Ensure it is less than model max length
    max_length = Math.min(max_length, this.model_max_length ?? Infinity);

    if (padding || truncation) {
      // Perform padding and/or truncation
      for (let i = 0; i < encodedTokens.length; ++i) {
        if (encodedTokens[i].input_ids.length === max_length) {
          continue;
        } else if (encodedTokens[i].input_ids.length > max_length) {
          // possibly truncate
          if (truncation) {
            truncateHelper(encodedTokens[i], max_length);
          }
        } else {
          // t.length < max_length
          // possibly pad
          if (padding) {
            padHelper(
              encodedTokens[i],
              max_length,
              (key) => (key === "input_ids" ? this.pad_token_id : 0),
              this.padding_side
            );
          }
        }
      }
    }

    const result = {};

    // Always return plain arrays (no Tensor)
    for (const key of Object.keys(encodedTokens[0])) {
      result[key] = encodedTokens.map((x) => x[key]);
    }

    // If not batched input, we unwrap
    if (!isBatched) {
      for (const key of Object.keys(result)) {
        result[key] = result[key][0];
      }
    }

    return /** @type {BatchEncoding} */ (result);
  }

  /**
   * Encodes a single text using the preprocessor pipeline of the tokenizer.
   *
   * @param {string|null} text The text to encode.
   * @returns {string[]|null} The encoded tokens.
   */
  _encode_text(text) {
    if (text === null) return null;

    // Actual function which does encoding, for a single text
    // First, we take care of special tokens. Needed to avoid issues arising from
    // normalization and/or pretokenization (which may not preserve special tokens)
    const sections = this.added_tokens_splitter.split(text);

    // Process left/right stripping of added tokens
    for (let i = 0; i < sections.length; ++i) {
      const addedToken = this.added_tokens_map.get(sections[i]);
      if (addedToken) {
        if (addedToken.lstrip && i > 0) {
          sections[i - 1] = sections[i - 1].trimEnd();
        }
        if (addedToken.rstrip && i < sections.length - 1) {
          sections[i + 1] = sections[i + 1].trimStart();
        }
      }
    }

    const tokens = sections.flatMap((x, section_index) => {
      if (x.length === 0) return [];
      if (this.added_tokens_map.has(x)) return [x]; // Return added tokens unchanged

      if (this.remove_space === true) {
        x = x.trim().split(/\s+/).join(" ");
      }
      if (this.do_lowercase_and_remove_accent) {
        x = x.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
      }

      if (this.normalizer !== null) {
        x = this.normalizer(x);
      }

      // If, after normalization, this section is empty (e.g., trimming whitespace),
      // we return an empty array
      if (x.length === 0) {
        return [];
      }

      const sectionTokens =
        this.pre_tokenizer !== null
          ? this.pre_tokenizer(x, {
              section_index,
            })
          : [x];

      const tokens = this.model(sectionTokens);

      return tokens;
    });

    return tokens;
  }

  /**
   * Encodes a single text or a pair of texts using the model's tokenizer.
   *
   * @param {string} text The text to encode.
   * @param {Object} options An optional object containing the following properties:
   * @param {string} [options.text_pair=null] The optional second text to encode.
   * @param {boolean} [options.add_special_tokens=true] Whether or not to add the special tokens associated with the corresponding model.
   * @param {boolean} [options.return_token_type_ids=null] Whether to return token_type_ids.
   * @returns {EncodingSingle} An object containing the encoded text.
   * @private
   */
  _encode_plus(
    text,
    {
      text_pair = null,
      add_special_tokens = true,
      return_token_type_ids = null,
    } = {}
  ) {
    const { tokens, token_type_ids } = this._tokenize_helper(text, {
      pair: text_pair,
      add_special_tokens,
    });

    const input_ids = this.model.convert_tokens_to_ids(tokens);

    const result = {
      input_ids,
      attention_mask: new Array(input_ids.length).fill(1),
    };
    if (
      (return_token_type_ids ?? this.return_token_type_ids) &&
      token_type_ids
    ) {
      result.token_type_ids = token_type_ids;
    }
    return result;
  }

  /**
   * Internal helper function to tokenize a text, and optionally a pair of texts.
   * @param {string} text The text to tokenize.
   * @param {Object} options An optional object containing the following properties:
   * @param {string} [options.pair=null] The optional second text to tokenize.
   * @param {boolean} [options.add_special_tokens=false] Whether or not to add the special tokens associated with the corresponding model.
   * @returns {{tokens: string[], token_type_ids?: number[]}} An object containing the tokens and optionally the token type IDs.
   */
  _tokenize_helper(text, { pair = null, add_special_tokens = false } = {}) {
    const tokens = this._encode_text(text);
    const tokens2 = this._encode_text(pair);

    return this.post_processor
      ? this.post_processor(tokens, tokens2, { add_special_tokens })
      : { tokens: mergeArrays(tokens ?? [], tokens2 ?? []) };
  }

  /**
   * Converts a string into a sequence of tokens.
   * @param {string} text The sequence to be encoded.
   * @param {Object} options An optional object containing the following properties:
   * @param {string} [options.pair] A second sequence to be encoded with the first.
   * @param {boolean} [options.add_special_tokens=false] Whether or not to add the special tokens associated with the corresponding model.
   * @returns {string[]} The list of tokens.
   */
  tokenize(text, { pair = null, add_special_tokens = false } = {}) {
    return this._tokenize_helper(text, { pair, add_special_tokens }).tokens;
  }

  /**
   * Encodes a single text or a pair of texts using the model's tokenizer.
   *
   * @param {string} text The text to encode.
   * @param {Object} options An optional object containing the following properties:
   * @param {string} [options.text_pair=null] The optional second text to encode.
   * @param {boolean} [options.add_special_tokens=true] Whether or not to add the special tokens associated with the corresponding model.
   * @param {boolean} [options.return_token_type_ids=null] Whether to return token_type_ids.
   * @returns {number[]} An array of token IDs representing the encoded text(s).
   */
  encode(
    text,
    {
      text_pair = null,
      add_special_tokens = true,
      return_token_type_ids = null,
    } = {}
  ) {
    return this._encode_plus(text, {
      text_pair,
      add_special_tokens,
      return_token_type_ids,
    }).input_ids;
  }
}

export { PreTrainedTokenizer }
