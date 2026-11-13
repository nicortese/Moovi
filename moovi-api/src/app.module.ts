import { readFileSync } from 'fs';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { MysqlDataSourceOptions } from 'typeorm/driver/mysql/MysqlDataSourceOptions';
import { AuthModule } from './auth/auth.module';
import { MoviesModule } from './movies/movies.module';
import { UsersModule } from './users/users.module';
import { PlatformsModule } from './platforms/platforms.module';
import { SyncModule } from './sync/sync.module';
import { ChatbotModule } from './chatbot/chatbot.module';

export function createMysqlOptions(cfg: Pick<ConfigService, 'get'>): MysqlDataSourceOptions {
  const port = Number(cfg.get('DB_PORT', 3306));
  return {
    type: 'mysql',
    host: cfg.get('DB_HOST', 'localhost'),
    port: Number.isFinite(port) ? port : 3306,
    username: cfg.get('DB_USER', 'root'),
    password: cfg.get('DB_PASSWORD', 'root'),
    database: cfg.get('DB_NAME', 'moovi_db'),
    entities: [__dirname + '/**/*.entity{.ts,.js}'],
    synchronize: false,
    poolSize: 3,
    ...(cfg.get('DB_SSL') === 'true' ? { ssl: mysqlSsl(cfg) } : {}),
  };
}

function mysqlSsl(cfg: Pick<ConfigService, 'get'>) {
  const configured = cfg.get<string>('DB_SSL_CA')?.trim();
  const ca = !configured
    ? undefined
    : configured.includes('BEGIN CERTIFICATE')
      ? configured.replace(/\\n/g, '\n')
      : readFileSync(configured, 'utf8');
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => createMysqlOptions(cfg),
    }),
    AuthModule,
    MoviesModule,
    UsersModule,
    PlatformsModule,
    SyncModule,
    ChatbotModule,
  ],
})
export class AppModule {}
