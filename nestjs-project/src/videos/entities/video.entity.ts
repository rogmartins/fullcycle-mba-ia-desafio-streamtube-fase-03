import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoErrorReason, VideoStatus } from '../videos.types';

@Entity('videos')
@Index(['channel_id', 'status'])
@Index(['status', 'created_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 12, unique: true })
  public_id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 50 })
  content_type: string;

  @Column({ type: 'bigint' })
  size_bytes: string;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  storage_key: string;

  @Column({ type: 'text', nullable: true })
  upload_id: string | null;

  @Column({ type: 'integer' })
  part_size_bytes: number;

  @Column({ type: 'integer' })
  part_count: number;

  @Column({ type: 'numeric', precision: 10, scale: 3, nullable: true })
  duration_seconds: string | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  codec_name: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  container_format: string | null;

  @Column({ type: 'boolean', nullable: true })
  moov_at_end: boolean | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({
    type: 'enum',
    enum: VideoErrorReason,
    nullable: true,
  })
  error_reason: VideoErrorReason | null;

  @Column({ type: 'text', nullable: true })
  error_detail: string | null;

  @Column({ type: 'integer', default: 0 })
  processing_attempts: number;

  @Column({ type: 'timestamp', nullable: true })
  uploaded_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
