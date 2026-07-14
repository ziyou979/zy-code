export class RootActionCompleted extends Error {
  constructor() {
    super('root action completed')
    this.name = 'RootActionCompleted'
  }
}
